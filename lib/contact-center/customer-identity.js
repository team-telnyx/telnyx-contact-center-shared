import {sourceText} from "../i18n/source-text.mjs";
export function supervisionCustomerIdentity(call, tUi = sourceText) {
  const outbound=String(call?.direction || "").toLowerCase()==="outbound";
  return {
    label:(outbound?call?.toName:call?.fromName) || call?.customerName || call?.contactName || tUi("Caller"),
    detail:(outbound?call?.toNumber:call?.fromNumber) || call?.customerNumber || call?.customerAddress || tUi("Unknown number"),
  };
}
