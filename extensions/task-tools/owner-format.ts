export function shortOwner(owner: string, max = 12): string {
	return owner.length > max ? `${owner.slice(0, max)}...` : owner
}

export function ownerAssignedSuffix(owner: string | null, sessionId: string | undefined): string {
	if (!owner) return ""
	if (owner === sessionId) return " (assigned: current)"
	return ` (assigned: ${shortOwner(owner)})`
}

export function ownerDisplay(
	owner: string | null,
	sessionId: string | undefined,
	options?: { none?: string; includeCurrentSessionId?: boolean },
): string {
	if (!owner) return options?.none ?? "-"
	if (owner === sessionId) {
		if (options?.includeCurrentSessionId) return `current (${sessionId ?? "unknown"})`
		return "current"
	}
	return owner
}
