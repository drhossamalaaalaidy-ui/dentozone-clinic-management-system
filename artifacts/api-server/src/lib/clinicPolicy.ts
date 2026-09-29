export function canWriteClinicalHistory(role: string): boolean {
  return role === "owner" || role === "dentist";
}

export function isNoShow(status: string): boolean {
  return status === "no_show" || status === "no-show";
}

export function countsAsAttending(status: string): boolean {
  return status !== "cancelled" && !isNoShow(status);
}