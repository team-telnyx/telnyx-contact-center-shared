import SmsAdmin from '@/components/sms/SmsAdmin';
import { AdminPageShell } from '@/components/contact-center/WorkspacePageLayout';
// Deep link for Admin → SMS → Templates; the sidebar keeps the SMS entry active.
export default function SmsTemplatesPage(){return <AdminPageShell><SmsAdmin initialSection="templates"/></AdminPageShell>;}
