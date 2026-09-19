// Scope results to the latest request, even when a transport ignores abort.
export function createLatestRequestScope() {
  let current=null;
  return {
    begin() {
      current?.abort();
      const controller=new AbortController();
      current=controller;
      return {signal:controller.signal,isCurrent:()=>current===controller && !controller.signal.aborted};
    },
    cancel() {current?.abort();current=null;},
  };
}
