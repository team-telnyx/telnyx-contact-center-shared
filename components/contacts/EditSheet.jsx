"use client";

import React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { IconEdit } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Edit sheet component for Contacts
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {string} props.contactId - Contact ID to edit (null for new contact)
 * @param {function} props.onSaveComplete - Callback when save is complete
 * @param {string} props.prefillPhone - Phone number to prefill when creating new contact
 */
export default function ContactEditSheet({
  open,
  onOpenChange,
  contactId,
  onSaveComplete,
  prefillPhone,
}) {
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [companyName, setCompanyName] = React.useState("");
  const [jobTitle, setJobTitle] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [mobile, setMobile] = React.useState("");
  const [businessPhone1, setBusinessPhone1] = React.useState("");
  const [businessPhone2, setBusinessPhone2] = React.useState("");
  const [homePhone1, setHomePhone1] = React.useState("");
  const [homePhone2, setHomePhone2] = React.useState("");
  const [emailAddress1, setEmailAddress1] = React.useState("");
  const [emailAddress2, setEmailAddress2] = React.useState("");
  const [addressStreet, setAddressStreet] = React.useState("");
  const [addressCity, setAddressCity] = React.useState("");
  const [addressState, setAddressState] = React.useState("");
  const [addressZip, setAddressZip] = React.useState("");
  const [addressCountry, setAddressCountry] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  // Load contact data when contactId changes
  React.useEffect(() => {
    async function loadContact() {
      if (!contactId || !open) {
        // Reset form for new contact
        if (!contactId && open) {
          setFirstName("");
          setLastName("");
          setDisplayName("");
          setCompanyName("");
          setJobTitle("");
          setDepartment("");
          setPhone(prefillPhone || "");
          setMobile("");
          setBusinessPhone1("");
          setBusinessPhone2("");
          setHomePhone1("");
          setHomePhone2("");
          setEmailAddress1("");
          setEmailAddress2("");
          setAddressStreet("");
          setAddressCity("");
          setAddressState("");
          setAddressZip("");
          setAddressCountry("");
          setNotes("");
        }
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(
          `/api/contacts/${encodeURIComponent(contactId)}`,
          {
            cache: "no-store",
          }
        );
        const d = await r.json();
        if (r.ok) {
          setFirstName(d.first_name || "");
          setLastName(d.last_name || "");
          setDisplayName(d.display_name || "");
          setCompanyName(d.company_name || "");
          setJobTitle(d.job_title || "");
          setDepartment(d.department || "");
          setPhone(d.phone || "");
          setMobile(d.mobile || "");
          setBusinessPhone1(d.business_phone_1 || "");
          setBusinessPhone2(d.business_phone_2 || "");
          setHomePhone1(d.home_phone_1 || "");
          setHomePhone2(d.home_phone_2 || "");
          setEmailAddress1(d.email_address_1 || "");
          setEmailAddress2(d.email_address_2 || "");
          setAddressStreet(d.address_street || "");
          setAddressCity(d.address_city || "");
          setAddressState(d.address_state || "");
          setAddressZip(d.address_zip || "");
          setAddressCountry(d.address_country || "");
          setNotes(d.notes || "");
        } else {
          notify({
            title: "Failed to load contact",
            description: d?.error || "",
            variant: "error",
          });
        }
      } catch (err) {
        notify({
          title: "Failed to load contact",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    if (open) {
      loadContact();
    }
  }, [contactId, open, prefillPhone]);

  async function onSave() {
    // Validate required fields
    if (!firstName && !lastName && !displayName && !companyName) {
      notify({
        title: "Validation error",
        description:
          "At least one of first name, last name, display name, or company name is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        first_name: firstName || null,
        last_name: lastName || null,
        display_name: displayName || null,
        company_name: companyName || null,
        job_title: jobTitle || null,
        department: department || null,
        phone: phone || null,
        mobile: mobile || null,
        business_phone_1: businessPhone1 || null,
        business_phone_2: businessPhone2 || null,
        home_phone_1: homePhone1 || null,
        home_phone_2: homePhone2 || null,
        email_address_1: emailAddress1 || null,
        email_address_2: emailAddress2 || null,
        address_street: addressStreet || null,
        address_city: addressCity || null,
        address_state: addressState || null,
        address_zip: addressZip || null,
        address_country: addressCountry || null,
        notes: notes || null,
      };

      const url = contactId
        ? `/api/contacts/${encodeURIComponent(contactId)}`
        : `/api/contacts`;
      const method = contactId ? "PATCH" : "POST";

      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (r.ok) {
        notify({
          title: contactId ? "Contact updated" : "Contact created",
          description: "The contact has been saved successfully",
          variant: "success",
        });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({
          title: "Failed to save contact",
          description: d?.error || "",
          variant: "error",
        });
      }
    } catch (err) {
      notify({
        title: "Failed to save contact",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconEdit className="size-5" />
            {contactId ? "Edit Contact" : "New Contact"}
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {loading ? (
                <>
                  <div>
                    <Skeleton className="h-4 w-40 mb-3" />
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                      <Skeleton className="h-9 w-full" />
                    </div>
                  </div>
                  <div className="border-t" />
                  <div>
                    <Skeleton className="h-4 w-32 mb-3" />
                    <div className="space-y-3">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Name Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Personal Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">
                            First name <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">
                            Last name <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Display name <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">
                            Company <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Job title</Label>
                          <Input
                            value={jobTitle}
                            onChange={(e) => setJobTitle(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Department</Label>
                        <Input
                          value={department}
                          onChange={(e) => setDepartment(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Phone Numbers Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Phone Numbers
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Phone</Label>
                          <Input
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Mobile</Label>
                          <Input
                            value={mobile}
                            onChange={(e) => setMobile(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Business phone 1</Label>
                          <Input
                            value={businessPhone1}
                            onChange={(e) => setBusinessPhone1(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Business phone 2</Label>
                          <Input
                            value={businessPhone2}
                            onChange={(e) => setBusinessPhone2(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Home phone 1</Label>
                          <Input
                            value={homePhone1}
                            onChange={(e) => setHomePhone1(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Home phone 2</Label>
                          <Input
                            value={homePhone2}
                            onChange={(e) => setHomePhone2(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Email Addresses Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Email Addresses
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Email address 1</Label>
                          <Input
                            type="email"
                            value={emailAddress1}
                            onChange={(e) => setEmailAddress1(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Email address 2</Label>
                          <Input
                            type="email"
                            value={emailAddress2}
                            onChange={(e) => setEmailAddress2(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Address Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Address
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Street</Label>
                        <Input
                          value={addressStreet}
                          onChange={(e) => setAddressStreet(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">City</Label>
                          <Input
                            value={addressCity}
                            onChange={(e) => setAddressCity(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">State</Label>
                          <Input
                            value={addressState}
                            onChange={(e) => setAddressState(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">ZIP code</Label>
                          <Input
                            value={addressZip}
                            onChange={(e) => setAddressZip(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Country</Label>
                          <Input
                            value={addressCountry}
                            onChange={(e) => setAddressCountry(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Notes Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Notes
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Notes</Label>
                        <Textarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          rows={4}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
