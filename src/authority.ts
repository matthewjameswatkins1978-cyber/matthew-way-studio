/** Explicit packet instructions that reserve execution for a later human go-ahead. */
export function requestsExecutionHold(packet: string): boolean {
  return packet.split(/\r?\n|[.!?]\s+/).some((raw) => {
    const line = raw.trim().replace(/^[-*]\s*/, "").replace(/^(?:mode|authority|instruction):\s*/i, "").replace(/[.!?]$/, "");
    return /^(?:plan only|planning only|inspect only(?: and wait for (?:my )?approval)?|read[- ]only(?: for now)?|do not (?:execute|start work|make changes)(?: yet| until (?:(?:my )?approval|I approve|Matthew approves))?|don't (?:execute|start work|make changes)(?: yet| until (?:(?:my )?approval|I approve|Matthew approves))?|wait for (?:my )?(?:approval|go[- ]ahead)(?: before (?:executing|implementing|starting))?|ask (?:me )?before (?:executing|implementing|starting))$/i.test(line);
  });
}
