import { Badge } from '@/components/ui/badge';
import { emailMessageStatus } from '@/lib/email/message-status.mjs';

const tones = {
  neutral: 'border-border bg-muted/50 text-muted-foreground',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
};
export default function EmailMessageStatus({ message }) {
  const { status, label, tone, title } = emailMessageStatus(message);
  return <Badge variant="outline" data-email-status={status} title={title} className={`shrink-0 capitalize ${tones[tone]}`}>{label}</Badge>;
}
