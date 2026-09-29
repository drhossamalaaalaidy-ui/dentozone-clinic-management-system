export function invalidatesReminderDrafts(
  previous: { optIn: boolean; channel: string } | undefined,
  next: { optIn: boolean; channel: string },
): boolean {
  return !next.optIn || Boolean(previous?.optIn && previous.channel !== next.channel);
}