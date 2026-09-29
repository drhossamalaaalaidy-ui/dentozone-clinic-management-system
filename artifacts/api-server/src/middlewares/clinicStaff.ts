import { clerkClient, getAuth } from "@clerk/express";
import { db, staffTable, type Staff, type StaffRole } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { getOidcSession } from "../lib/oidcSession";
import { staffIdentityLinkPatch } from "../lib/staffAuthPolicy";

interface StaffIdentity {
  subject: string;
  email: string;
  name: string;
  verified: boolean;
}

export async function requireStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let identity: StaffIdentity | null = null;
    if (process.env.AUTH_PROVIDER === "oidc") {
      const session = getOidcSession(req);
      if (session) {
        identity = {
          subject: session.subject,
          email: session.email,
          name: session.name,
          verified: session.verifiedEmail,
        };
      }
    } else {
      const clerkId = getAuth(req).userId;
      if (clerkId) {
        const clerkIdentity = await clerkClient.users.getUser(clerkId);
        const primaryEmail = clerkIdentity.emailAddresses.find(
          (address) => address.id === clerkIdentity.primaryEmailAddressId,
        );
        if (primaryEmail) {
          identity = {
            subject: clerkId,
            email: primaryEmail.emailAddress,
            name: clerkIdentity.fullName || primaryEmail.emailAddress.split("@")[0],
            verified: primaryEmail.verification?.status === "verified",
          };
        }
      }
    }
    if (!identity) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    if (!identity.verified) {
      res.status(403).json({ error: "A verified email address is required" });
      return;
    }
    const email = identity.email.trim().toLowerCase();

    // Serializing the first owner claim prevents two simultaneous sign-ups from
    // both gaining owner privileges. Production needs an explicitly configured
    // owner email rather than accepting an arbitrary first public visitor.
    const staff = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(723125802)`);
      const [byId] = await tx.select().from(staffTable).where(eq(staffTable.clerkUserId, identity!.subject));
      if (byId) return byId.email.trim().toLowerCase() === email ? byId : null;

      const [byEmail] = await tx.select().from(staffTable).where(eq(staffTable.email, email));
      if (byEmail) {
        if (byEmail.status === "suspended") return byEmail;
        const linkPatch = staffIdentityLinkPatch(byEmail, identity!, process.env.AUTH_PROVIDER === "oidc" ? "oidc" : "clerk");
        if (!linkPatch) return null;
        const [linked] = await tx.update(staffTable).set(linkPatch)
          .where(eq(staffTable.id, byEmail.id)).returning();
        return linked;
      }

      const [firstStaff] = await tx.select({ id: staffTable.id }).from(staffTable).limit(1);
      if (firstStaff) return null;
      const ownerEmail = process.env.DENTOZONE_OWNER_EMAIL?.trim().toLowerCase();
      if ((ownerEmail && email !== ownerEmail) || (!ownerEmail && process.env.NODE_ENV === "production")) {
        return null;
      }
      const [owner] = await tx.insert(staffTable).values({
        clerkUserId: identity!.subject,
        email,
        name: identity!.name || email.split("@")[0],
        role: "owner",
        status: "active",
      }).returning();
      return owner;
    });

    if (!staff || staff.status !== "active") {
      res.status(403).json({ error: "This account is not authorized for DentOzone. Ask the clinic owner for an invitation." });
      return;
    }
    res.locals.staff = staff;
    next();
  } catch (error) {
    next(error);
  }
}

export function currentStaff(res: Response): Staff {
  return res.locals.staff as Staff;
}

export function allowRoles(...roles: StaffRole[]) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!roles.includes(currentStaff(res).role)) {
      res.status(403).json({ error: "Your clinic role does not allow this action" });
      return;
    }
    next();
  };
}