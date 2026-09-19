import { withEmailUser,readEmailJson } from '@/lib/email/api';
import { emailTemplateModels,generateEmailTemplate } from '@/lib/email/template-ai.mjs';

export const dynamic='force-dynamic';
export const GET=request=>withEmailUser(request,()=>emailTemplateModels(),{admin:true});
export const POST=request=>withEmailUser(request,async()=>generateEmailTemplate(await readEmailJson(request)),{admin:true});
