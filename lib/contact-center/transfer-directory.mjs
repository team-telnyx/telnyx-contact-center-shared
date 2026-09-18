// Transfer destinations come from the authenticated shared address book.
// Supervisor statistics are a separate, permission-filtered resource.
export function transferDirectory(users, currentUserId) {
  return (Array.isArray(users) ? users : [])
    .filter(user=>user.id&&user.id!==currentUserId&&
      [user.telephony_user_name,user.mobile,user.voice_number].some(value=>String(value||'').trim()))
    .map(user=>({userId:user.id,username:user.username,firstName:user.first_name,lastName:user.last_name,
      telephonyUserName:user.telephony_user_name,mobile:user.mobile,voiceNumber:user.voice_number,
      status:user.agent_status||'Unknown'}));
}
