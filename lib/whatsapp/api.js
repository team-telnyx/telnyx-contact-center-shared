import { withEmailUser, readEmailJson } from '../email/api';
// The authentication, admin, same-origin and body-size guards are channel-neutral.
export const withWhatsAppUser=(request,operation,options={})=>withEmailUser(request,operation,{...options,label:'WhatsApp'});
export const readWhatsAppJson=readEmailJson;
