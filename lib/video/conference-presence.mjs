// The worker reports actual room membership. A claimed role alone, an ACD
// assignment or an issued-but-unbound admission is not evidence of joining.
export function hasJoinedConferenceAgent(members, participants = []) {
  return members.some(member => member.role === "agent" && member.participant_id &&
    participants.some(participant => !participant.self && participant.participantId === member.participant_id && participant.admissionId === member.id));
}
