import { withEmailUser, readEmailJson } from '../email/api';
// The authentication, admin, same-origin and body-size guards are channel-neutral.
export const withSmsUser=(request,operation,options={})=>withEmailUser(request,operation,{...options,label:'SMS'});
export const readSmsJson=readEmailJson;
