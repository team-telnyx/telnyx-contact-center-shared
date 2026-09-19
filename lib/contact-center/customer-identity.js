export function supervisionCustomerIdentity(call) {
  const outbound=String(call?.direction || "").toLowerCase()==="outbound";
  return {
    label:(outbound?call?.toName:call?.fromName) || call?.customerName || call?.contactName || "Caller",
    detail:(outbound?call?.toNumber:call?.fromNumber) || call?.customerNumber || call?.customerAddress || "Unknown number",
  };
}
