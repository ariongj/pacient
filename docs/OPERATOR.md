# Operator guide

The **platform administrator** runs the service: accounts, the facilities that are customers, their
subscriptions and invoices, the terms of use and privacy notice, and the operator's own details.
The administrator **never sees patient records** – no staff or clinical endpoint opens for this
role, and the account pages show account data only (no national ID, nothing clinical).

The first administrator is created on the server with `deploy/first-admin.sh` (see
[GO-LIVE.md](GO-LIVE.md)); further administrators are invited under **Users**. Two-step sign-in is
required. Keep at least two administrators: the last active one cannot be disabled or changed.

Demo sign-in (synthetic data only): `admin@pacient.local`.

## The portal

| Menu                                                    | What it is for                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Overview**                                            | Facilities by subscription status, monthly revenue, open and overdue invoices, |
|                                                         | renewals in the next 30 days, accounts waiting for activation, recent changes  |
| **Customers and subscriptions › Facilities**            | Every facility with plan, status, seats and renewal; add a new customer        |
| **Customers and subscriptions › Invoices and payments** | All invoices; record a payment, void, print, download, e-mail again            |
| **Customers and subscriptions › Plans**                 | What facilities can subscribe to, and at what price                            |
| **Users**                                               | Every account of the service                                                   |
| **Platform › Operator settings**                        | Company details, payment terms, VAT, trial and grace periods, notice to users  |
| **Platform › Terms and privacy**                        | Versions of the two legal texts, publishing, who accepted                      |
| **Platform › System health**                            | Database, e-mail and SMS queues, background workers                            |
| **Platform › Administrative actions**                   | Everything administrators did, by category                                     |

## Users

Search by name or e-mail; filter by role, facility and state (active, disabled, locked, waiting
for activation, without two-step sign-in). Patient accounts are found only by their exact e-mail
address (a support case), never by name or by browsing.

- **Invite** staff of any facility, Ministry officials and other administrators. The person gets an
  activation link by e-mail (valid 72 hours). Doctors, nurses and pharmacists need their licence
  number. Patients are never invited here – their facility registers them.
- **Change** name, role, facility, specialty or licence number. A role or facility change is refused
  while the person still has patients in their care, result cover, results awaiting review, notes
  in draft or prescriptions the pharmacy returned to them; these are handed over (or signed,
  resubmitted or cancelled) first.
- **Disable / enable**, **unlock** after too many failed sign-ins, **send a password reset**,
  **reset two-step sign-in** (the person sets it up again at the next sign-in and is notified),
  **sign out everywhere**, **send the invitation again**.

Every action asks for a reason where it matters, is written to the audit trail together with the
change, and appears in the account's history. An administrator cannot act on their own account
(use **Settings › Security**). For patient accounts only disable, enable, unlock, sign out and
password reset are offered; their personal details are kept by their facility. A patient whose
invitation link expired, or who lost their authenticator and recovery codes, goes to their
facility: reception or a director verifies their identity in person and, on the patient's page,
sends the invitation again (to the e-mail address on file, which they may correct first) or resets
their two-step sign-in. Clinicians can send only the first invitation; a closed account is not
touched.

Directors keep inviting and managing their own staff, as before.

## Subscriptions

A facility has at most one subscription. A facility without one – for example a public facility
run by the Ministry – works without limits.

**New customer** creates the facility, the first director's invitation and its subscription in
one step (the director is invited first, so they are told about the first invoice). An existing
facility gets a subscription from its page. A subscription keeps the number of staff accounts
(seats) of its plan as it was when it started or changed plan: editing a plan later changes neither
the price nor the seats of running subscriptions.

| Status          | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| Trial           | Free for the trial period (operator settings, 30 days by default); nothing is invoiced |
| Active          | Invoiced at the start of every period (monthly or yearly)                              |
| Payment overdue | An invoice passed its due date                                                         |
| Suspended       | Unpaid for longer than the grace period (30 days by default), or suspended by hand     |
| Cancelled       | Ended, now or at the end of the paid period                                            |

Periods follow the calendar in Kosovo and keep the day of the month they started on: a
subscription that started on 31 January renews on 28 February, then on 31 March.

What happens by itself (checked every six hours):

- a trial that ends becomes active and gets its first invoice;
- at the end of each period the subscription renews and the next invoice is issued;
- an invoice whose due date has passed marks the subscription as overdue; when it is still unpaid
  after the grace period, the subscription is suspended. The grace period counts from the due date
  of the oldest invoice that is still unpaid;
- a cancellation scheduled for the end of the period takes effect then – also when the
  subscription was suspended in the meantime;
- directors are told a week before a trial ends or a renewal, when an invoice is issued, overdue,
  and when the status changes – of an overdue invoice always before a suspension, also when both
  happen at one check. A reminder that finds no active director (for example before the first
  director is invited) is sent at a later check, once there is one.

By hand, on the facility's page: change plan, billing cycle, number of staff accounts (seats) or an
agreed price; start the paid subscription before the trial ends; suspend and reactivate; cancel
(now, or at the end of the period) and withdraw a cancellation; add an internal note.

- A change of **plan or price** applies from the next invoice; to apply it now, void the invoice
  of the current period and issue it again. A change of **seats** applies at once; a new plan
  brings its seat limit.
- A change of **billing cycle** takes effect at the next renewal: the page shows, for example,
  "changes to yearly on 1 Dec 2026", and the directors see it too. The current period keeps the
  cycle and price it was invoiced with, also when its invoice is voided and issued again. Choose the
  current cycle again to withdraw the change. During a trial the cycle changes at once.
- **Start the paid subscription now** is refused while a cancellation is scheduled: withdraw the
  cancellation first.
- **Suspend** by hand: only **Reactivate** lifts it – a payment does not. A suspension for
  non-payment ends by itself when the overdue invoices are paid (a suspension whose cause is not
  recorded is treated as one by hand). The facility's page shows since when and why a
  subscription is suspended, and what reactivating would do next. A scheduled cancellation stays
  and ends the subscription at the end of the period.
- **Reactivate**: a trial whose end date has not passed is a trial again; one whose trial ended
  while suspended starts its first paid period on the day of reactivation, with its invoice. With
  invoices still overdue, the subscription is overdue again with a new grace period. A period
  that ended while suspended starts again on the day of reactivation, with its invoice; a period
  still running keeps its renewal date. If a cancellation was scheduled and its date has passed,
  the subscription ends as scheduled instead, without a new invoice: the page says so, and your
  note is kept in the history.
- **Cancel now** leaves the open invoices – also the one of the current period – open: record
  their payment, or void an invoice the facility does not owe. A new subscription for the facility
  can be started only when none of its invoices is open.

Every step is in the facility's **History**, which cannot be edited: who, when, from which status
to which, and the note.

### What a subscription never does

**A subscription never limits clinical work.** Whatever its status, everyone keeps signing in and
working with patient records. Only two things depend on it:

- no **new** staff accounts can be added when all seats are used, or while the subscription is
  suspended or has ended. A disabled account can always be enabled again whatever the status – it
  only needs a free seat, and a director not even that;
- the facility's directors see a notice with a link to **Subscription and invoices**.

Patients never count as seats. See hazard H74 in [CLINICAL-SAFETY.md](CLINICAL-SAFETY.md).

## Invoices and payments

Invoices are numbered without gaps per year (`PAC-2026-00001`; the prefix is an operator setting).
An invoice copies the operator's and the customer's details and the VAT rate at the moment it is
issued; afterwards only its payment or its voiding can be recorded – the database refuses any
other change.

An invoice is due at the end of the due date in Kosovo (payment terms in days after the issue
day; 0 means by the end of the issue day), and it is overdue only once that day has passed. An
invoice with nothing to pay (a free plan or an agreed price of 0) is issued as paid ("No charge")
and is never overdue.

Pacient does not take card payments. Customers pay by bank transfer with the invoice number as
the reference, and the administrator **records the payment** (amount, date, method, reference –
see [Payments and credit notes](#payments-and-credit-notes)). When nothing else is overdue, an
overdue subscription, or one suspended for non-payment, is active again at once; a suspension made
by hand stays until it is reactivated. When other invoices are still overdue, the grace period
counts from the oldest of them – a subscription suspended because of the invoice just paid is
overdue again if that invoice's grace period has not ended, and its directors are told that it is
no longer suspended but an invoice is still overdue (never that it is active again). An invoice
issued by mistake and noticed straight away is **voided** with a reason; it keeps its number, and
the subscription is checked as after a payment. Anything later is corrected with a credit note.

**Paid this year** on the invoices page counts payments of the calendar year in Kosovo, like the
invoice numbers.

Directors see their plan, seats, history and invoices under **Facility management › Subscription
and invoices**, and can print every invoice or download it as a PDF.

### Invoices reach the customer by e-mail

Every invoice is **e-mailed when it is issued** – by an administrator's action or by the
subscription worker – to each billing e-mail of the facility's billing details and to each of its
active directors, every address once (the same address in other letters counts once). The PDF is
attached when the message is sent: it is drawn from the issued invoice at that moment, so nothing
PDF-shaped is stored, and the PDF always shows the invoice exactly as it was issued. The e-mail
says the number, the period, the amount, the due date, the IBAN and the payment reference – never
anything clinical. A director reads it in their own language; a billing address without an
account reads Albanian.

When an invoice becomes overdue, the **overdue reminder** to the directors also sends the invoice
again to the same addresses (once per overdue period; it reaches the billing e-mails even when the
facility has no director yet).

On the invoice page, **Sent by e-mail** lists every message: when it was queued, why (on issue,
overdue reminder, sent again – with who sent it), the address and whether it went out (sent, waiting,
not delivered with the mail server's answer). The invoices list shows **Sent on**: when the invoice
first reached the mail server. **Send again** e-mails it once more to the current addresses (useful
after correcting a billing e-mail); it is audited (`billing.invoice_sent`). A voided invoice is not
sent, and with no billing e-mail and no active director there is nobody to send to: the page says
so. **Download PDF** gives the invoice as a file in your own language; directors download their
facility's invoices and credit notes from **Documents to download**.

Invoices without VAT say **Not registered for VAT** instead of "VAT 0 %".

## Billing details

### Billing is ready only with the operator's details

An invoice keeps the operator's details for good, so no invoice is issued until **Operator
settings** has the operator's name, address, fiscal number (NUI), IBAN and – while VAT is charged
– the VAT number. Until then:

- the **Overview** shows **Billing is not ready** with the missing settings and a link to them;
- starting a paid subscription, **End the trial now** and **Invoice the current period** are not
  offered (a trial can still be started), and the server refuses any action that would issue an
  invoice with the list of missing settings – also recording a payment or reactivating when that
  would start a new period with its invoice;
- the subscription worker leaves a trial that ended, or a period that ended, as it is (nothing is
  invoiced and the status does not change) and raises the operator alert
  `billing.settings_incomplete`; at its next run after the settings are complete it issues the
  invoices it held back, with their periods as they were due, and clears the alert.

Billing never restricts sign-in, existing accounts or clinical work (hazard H74). The settings page
refuses a VAT rate above 0 without a VAT number.

### A facility's billing details

On the facility's page, **Billing details** says who is invoiced for it: the **legal name** of the
entity that pays, its **business number (NUI)**, **fiscal** and **VAT number**, a **billing
address**, up to three **billing e-mails**, a **contact person** and the **customer reference**
(their purchase order or contract number, printed on invoices). Enter them with the new customer,
or later with **Add billing details**. They are business data of the customer, shown in full.

Every invoice copies them, as they are at that moment, under **Bill to** (with the facility's own
name beside a different legal name); an invoice already issued never changes. Without billing
details, invoices name the facility as it is registered in Pacient and are e-mailed to its
directors only.

Saving them is audited (`billing.profile_changed`, with the names of the fields that changed, not
their values) and noted in the facility's internal history. Directors see them, read-only, under
**Subscription and invoices**, and ask the operator to change them.

## Payments and credit notes

An issued invoice never changes its amounts. What happens to it afterwards is recorded beside it,
on the invoice page under **Payments and balance** and **Credit notes**: what was paid, what was
credited, what is **still owed**, and – when more was paid and credited than the total – what is
**to refund**. An invoice is settled (Paid) once its payments and credit notes reach its total.

**Recording a payment.** _Record payment_ takes the amount received (by default everything still
owed), the date, the method and the bank reference. A part leaves the invoice open with the rest
as its balance – it is still overdue after its due date, and the subscription stays "payment
overdue" until the invoice is paid in full. The payment that brings the balance to 0 settles the
invoice, and the subscription's standing is checked as described under
[Invoices and payments](#invoices-and-payments). More than what is still owed is refused: record
what was owed and give the rest back outside Pacient.

**Reversing a payment.** A payment recorded by mistake – a transfer the bank returned, or one
recorded on the wrong invoice – is reversed from the invoice page with a reason, never edited or
deleted. It stays in the list, struck through, with who reversed it, when and why. A settled
invoice that is no longer paid in full opens again. If it is past its due date, an active
subscription is "payment overdue" again, with the grace period counting from the oldest overdue due
date, and its directors are told; it is never suspended by the reversal itself – the subscription
worker does that once the grace period is over, as for any overdue invoice. Clinical work, sign-in
and existing accounts are never affected (hazard H74).

**Credit notes.** To reduce or cancel what an invoice charges after it was sent – a discount
agreed later, days without service, an invoice issued twice – issue a **credit note** from the
invoice page: an amount (VAT included) of at most the invoice total less earlier credit notes, and
a reason, which is printed on it. A credit note:

- is numbered without gaps per calendar year in Kosovo, `PAC-CN-2026-00001` (with the invoice
  prefix of the operator settings);
- copies the operator's and the customer's details from the invoice it corrects, not from today's
  settings, and splits the VAT at that invoice's rate – the credit note that completes an invoice
  takes exactly what is left of its net amount and VAT;
- settles an open invoice when it brings what is still owed to 0 (the invoice shows "Credit note"
  as the method, with the credit note's number), and the subscription's standing is checked as after
  a payment;
- on an invoice already paid, leaves the invoice paid and shows the amount **to refund**. Refunds
  are made outside Pacient, by bank transfer; record the refund as a note in the subscription
  history (_Add note_ on the organisation page);
- is e-mailed with the invoice's recipients, and the facility's directors are notified and see it
  next to their invoices (**Subscription and invoices › Credit notes**), printable like an
  invoice;
- can never be changed or deleted (the database refuses). A mistake in a credit note is corrected
  by another document, never by editing it.

**Voiding** is only for a mistake noticed straight away: an invoice issued in the current month in
Kosovo, without any payment (also one reversed since) or credit note, and not yet e-mailed to the
customer (no e-mail with it went out). Otherwise Pacient refuses and asks for a credit note
instead. An e-mail with the invoice still waiting to be sent does not prevent the void.

Reversing a payment, issuing a credit note and voiding ask for your password again (in a dialog
that appears by itself). Every payment, reversal and credit note is recorded in the administrative
audit with its amount, in the same transaction as the change.

## Exports for the accountant

**Invoices and payments › Export for the accountant** downloads four CSV files for a month, a
quarter or a year (the month before is preselected):

- **Invoices** – invoices issued in the period (also voided ones, so the numbers have no gaps)
  with the customer's numbers as frozen on the invoice, net amount, VAT rate and amount, total,
  status, and what was paid and credited and the balance at the time of the export.
- **Payments and reversals** – money received in the period by payment date; a reversal is a
  separate negative row on the day it was reversed, with its reason. A period already handed over
  never changes because of a later correction.
- **Credit notes** – credit notes issued in the period, with the invoice each corrects, the
  reason, net amount, VAT and total.
- **Sales book (in Albanian)** – invoices and credit notes by number, credit notes as negative
  amounts and voided invoices with nothing (marked "E anuluar"), then the totals per VAT rate and
  the grand total. Column headers in Albanian.

The files are UTF-8 with a byte order mark (Excel opens them with the right letters),
comma-separated with every cell in quotes; dates are calendar days in Kosovo (2026-11-24) and
amounts are euros with a decimal point (149.00, -50.00). Text that a spreadsheet would run as a
formula (starting with `=`, `+`, `-` or `@`) is kept as text with a leading apostrophe. Column
headers follow your language, except in the sales book.

The files hold business data of the operator's customers only – never anything about patients.
Each download asks for your password again and is recorded in the administrative audit with the
export and its period (nothing else). A period is at most one year.

## Operator settings

Company name, address, fiscal and VAT number, bank and IBAN, support and privacy contacts –
printed on invoices and referred to by the legal texts. A new IBAN is checked before it is saved
(its country's length – 20 characters for Kosovo – and its check digits, which are always 02–98),
because every invoice issued afterwards keeps it. An IBAN saved before the check was this strict
is not checked again when you save other settings (an urgent notice is never held up by it), but
the page warns until you correct it. Payment terms (days until an invoice is due), VAT rate (0 when
not VAT-registered), trial length and grace period apply to invoices and subscriptions from then
on; issued invoices and published legal texts do not change.

**Notice to users** shows one line to everyone who is signed in, for example planned maintenance,
until the time you set. Open sessions pick up a new or changed notice within a few minutes (or
when the window gets focus), the line disappears at its end time, and it is never printed.

## Terms of use and privacy notice

Each text has versions, each version one text per language (Albanian, Serbian, English). Start a
draft from the built-in template, edit it, and publish. **The templates are drafts: have a lawyer
review them before you publish.** The operator's details must be filled in first, because the texts
refer to them: on publishing, `{operatorName}`, `{privacyEmail}` and the other details are written
into the text, so a later change to the operator settings never changes a published version – what
users read is what they accepted. Each value is written in once, as typed (a value that looks like
a placeholder stays as it is). The text as written, with its placeholders, is kept with the
version: **New version › Start from the current version** copies that, so the new version gets the
details of the day it is published. A version published before the text as written was kept is
copied as it was published, so it may contain the operator details as they were then: the form
warns, and you check them in the draft (or put the placeholders back) before publishing.

A published version cannot be changed or deleted – publish a new version instead. When a version
asks for acceptance, every user accepts it at their next sign-in before continuing; the acceptance
(who, which version, when) is stored and listed under the version (patient accounts by role and
time only, without a name). Administrators are not asked. A later version for information only
(for example a typo correction) does not ask those who accepted already, but whoever never
accepted the latest version that asked – a new account, say – accepts the current one; the page
then shows those acceptances under the current version too.
The public pages `/legal/terms` and `/legal/privacy` always show the current version (`/terms`
leads there too; `/privacy` is the directors' and the Ministry's data protection workspace).

If the check for pending texts cannot be reached or is slow, or the acceptance cannot be recorded
(an error, no answer within 10 seconds, or a conflict that fetching the current text again does
not resolve), the user is let in (**Continue – you will be asked again next time**), and once the
workspace is open it stays open until the next sign-in or page load, when the text is shown again:
the legal gate never stands between a clinician and a patient (hazard H75). `npm run
check:legal-gate` checks this in a browser before each release.

## Agreements

To be written.

## Administrative actions and system health

**Administrative actions** lists what administrators did – accounts, subscriptions and invoices,
platform settings and legal texts – with the person, the target and the reason. It is part of the
same append-only audit trail as everything else. A patient's portal account is never named there
(only "Patient account"), and what the system did to one – closing it when a death is registered,
opening it again when the registration is withdrawn – is not listed at all: a list of those would
be a list of deceased patients. Those entries stay in the audit trail and in that account's own
history under **Users**.

**System health** shows the database, e-mail and SMS waiting or failed, and the background
workers. Check it after go-live and when someone reports a missing e-mail.

## Requests

To be written.

## Alerts and background jobs

To be written.

## Recovering an administrator

To be written.

## Before the first customer

1. **Operator settings** – complete them.
2. **Terms and privacy** – reviewed by a lawyer, published in all three languages.
3. **Plans** – names, prices and seat limits.
4. E-mail works (send yourself an invitation or a password reset).
5. A second administrator exists.
6. Backups run and a restore was verified ([GO-LIVE.md](GO-LIVE.md), step 6).
