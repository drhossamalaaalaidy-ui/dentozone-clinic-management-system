import { createContext, useContext, type ReactNode } from "react";

const AuthActionsContext = createContext<{ signOut: () => void } | null>(null);

export function AuthActionsProvider({
  signOut,
  children,
}: {
  signOut: () => void;
  children: ReactNode;
}) {
  return (
    <AuthActionsContext.Provider value={{ signOut }}>
      {children}
    </AuthActionsContext.Provider>
  );
}

export function useAuthActions() {
  const actions = useContext(AuthActionsContext);
  if (!actions) throw new Error("Authentication actions are not available");
  return actions;
}