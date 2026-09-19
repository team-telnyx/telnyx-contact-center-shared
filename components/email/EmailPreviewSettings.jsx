"use client";
import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { emailPreviewSettings } from '@/lib/email/preview-settings.mjs';
import EmailBody from './EmailBody';

const sample={id:'preview-example',body:'Hello Alex,\n\nThank you for your message. Your request is being reviewed.\n\nCustomer Support',html_body:'<h2>Hello Alex,</h2><p>Thank you for your message. Your request is <strong>being reviewed</strong>.</p><p>Customer Support</p>'};

export default function EmailPreviewSettings({value,disabled,onSave}) {
  const [settings,setSettings]=useState(()=>emailPreviewSettings(value));
  const change=patch=>setSettings(current=>({...current,...patch}));
  return <Card>
    <CardHeader><CardTitle>Email preview</CardTitle><p className="text-xs text-muted-foreground">Apply the same display settings to every user in Agent Desktop, supervisor previews and interaction history.</p></CardHeader>
    <CardContent className="space-y-6">
      <form className="space-y-5" onSubmit={e=>{e.preventDefault();void onSave(settings);}}>
        <fieldset disabled={disabled} className="space-y-5">
          <div className="space-y-2"><label htmlFor="email-preview-format" className="text-sm font-medium">Message format</label><select id="email-preview-format" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={settings.format} onChange={e=>change({format:e.target.value})}><option value="text">Plain text</option><option value="html">Formatted HTML when available</option></select><p className="text-xs text-muted-foreground">Messages without HTML always display as plain text. Users cannot override this setting in a message.</p></div>
          <div className="flex items-start justify-between gap-6"><div className="space-y-1"><label htmlFor="email-preview-inline" className="text-sm font-medium">Show embedded images</label><p id="email-preview-inline-help" className="text-xs text-muted-foreground">Display images included in the email, such as signatures and inline screenshots, when using formatted HTML.</p></div><Switch id="email-preview-inline" aria-describedby="email-preview-inline-help" checked={settings.showInlineImages} onCheckedChange={showInlineImages=>change({showInlineImages})}/></div>
          <div className="flex items-start justify-between gap-6"><div className="space-y-1"><label htmlFor="email-preview-remote" className="text-sm font-medium">Load external images automatically</label><p id="email-preview-remote-help" className="text-xs text-muted-foreground">Load images from external HTTPS sites when using formatted HTML. This may let the sender detect that a message was opened.</p></div><Switch id="email-preview-remote" aria-describedby="email-preview-remote-help" checked={settings.loadRemoteImages} onCheckedChange={loadRemoteImages=>change({loadRemoteImages})}/></div>
        </fieldset>
        <Button type="submit" disabled={disabled}><Save className="mr-2 size-4"/>Save preview settings</Button>
      </form>
      <div className="space-y-3 border-t pt-5"><h3 className="text-sm font-medium">Example preview</h3><EmailBody message={sample} settings={settings}/></div>
    </CardContent>
  </Card>;
}
