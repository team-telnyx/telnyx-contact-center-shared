import { normalizeCalendar } from './evaluator.mjs';

function annualSegments(entry) {
  if (new Date(entry.endDate) - new Date(entry.startDate) >= 365 * 86400000) return [['01-01','12-31']];
  const start=entry.startDate.slice(5),end=entry.endDate.slice(5);
  return start<=end ? [[start,end]] : [[start,'12-31'],['01-01',end]];
}
export function mergeCalendarImport(current, incoming) {
  const base=normalizeCalendar(current), imported=normalizeCalendar(incoming);
  const entries=imported.entries.filter(entry=>!base.entries.some(old=>{
    if(old.id===entry.id)return true;
    if(old.repeat==='once'&&entry.repeat==='once')return old.startDate<=entry.endDate&&entry.startDate<=old.endDate;
    return annualSegments(old).some(a=>annualSegments(entry).some(b=>a[0]<=b[1]&&b[0]<=a[1]));
  }));
  // An empty draft must not certify years that were never imported. Once it
  // contains reviewed entries, preserve its explicitly configured coverage.
  return normalizeCalendar({
    coverageStart:base.entries.length ? [base.coverageStart,imported.coverageStart].sort()[0] : imported.coverageStart,
    coverageEnd:base.entries.length ? [base.coverageEnd,imported.coverageEnd].sort().at(-1) : imported.coverageEnd,
    entries:[...base.entries,...entries],
  });
}
