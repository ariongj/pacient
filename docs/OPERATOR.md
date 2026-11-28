# Operator guide

The **platform administrator** runs the service: accounts, the facilities that are customers, their
subscriptions and invoices, the terms of use and privacy notice, and the operator's own details.
The administrator **never sees patient records** – no staff or clinical endpoint opens for this
role, and the account pages show account data only (no national ID, nothing clinical).

The first administrator is created on the server with `deploy/first-admin.sh` (see
[GO-LIVE.md](GO-LIVE.md)); further administrators are invited under **Users**. Two-step sign-in is
required. Keep at least two administrators: the last active one cannot be disabled or changed.

An administrator's session ends 12 hours after signing in, however busy the day
(`ADMIN_SESSION_HOURS`), and the browser signs an administrator out after 30 minutes without
input, with a warning and **Stay signed in** five minutes before. What would hand someone the
operator's powers or its customers' money asks for your password again first (**Confirm it is
you**): inviting or changing an administrator, resetting two-step sign-in, disabling an account or
signing it out everywhere, a new IBAN, bank, VAT rate or number or invoice prefix, publishing a
legal text, payment reversals, credit notes and exports. Five wrong passwords there lock your
account for 15 minutes, as at sign-in.

Demo sign-in (synthetic data only): `admin@pacient.local`.

## The portal

| Menu                                                    | What it is for                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Overview**                                            | Facilities by subscription status, monthly revenue, open and overdue invoices, |
|                                                         | renewals in the next 30 days, accounts waiting for activation, recent changes  |
| **Customers and subscriptions › Facilities**            | Every facility with plan, status, seats and renewal; add a new customer        |
| **Customers and subscriptions › Invoices and payments** | All invoices; record a payment, void, print, download, e-mail again            |
| **Customers and subscriptions › Plans**                 | What facilities can subscribe to, and at what price                            |
| **Customers and subscriptions › Requests**              | What facilities ask the operator: answer, set the status                       |
| **Users**                                               | Every account of the service                                                   |
| **Platform › Operator settings**                        | Company details, payment terms, VAT, trial and grace periods, notice to users  |
| **Platform › Terms and privacy**                        | Legal texts and agreements: versions, publishing, who accepted                 |
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
change, and appears in the account's history. Inviting an administrator, any change to an
administrator or making someone one, resetting two-step sign-in, disabling and signing out
everywhere ask for your password again first. An administrator cannot act on their own account
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
PDF-shaped is stored. Its lines, amounts and parties are always those it was issued with; the
payment box and the status line say what is owed when it is drawn (sent or downloaded): the
total, **Still to pay** with the rest of an invoice paid or credited in part, **This invoice is
paid** once it is settled (with the day), nothing to pay on a voided one. The e-mail says the
number, the period, what is owed as it is queued – **Amount to pay** with the due date, **Still to
pay: X of Y**, or **This invoice is paid – attached for your records** (no request to pay, no
IBAN) – and, while something is owed, the IBAN and the payment reference; never anything
clinical. A director reads it in their own language, and the attached PDF is in the same language
even if the director changes it before the message goes out; a billing address without an account
reads Albanian.

When an invoice becomes overdue, the **overdue reminder** to the directors also sends the invoice
again to the same addresses – each overdue invoice once per overdue period, so an invoice that
becomes overdue later in the same period is sent when it does (it reaches the billing e-mails even
when the facility has no director yet).

**A voided invoice is never sent.** Voiding withdraws its e-mails that are still waiting (for
example while the mail server is unreachable, or before SMTP is configured): they are not sent,
and the list shows them as **Not sent – the invoice was voided**. The e-mail worker checks again
before it sends.

On the invoice page, **Sent by e-mail** lists every message: when it was queued, why (on issue,
overdue reminder, sent again – with who sent it), the address and whether it went out (sent, waiting,
not delivered with the mail server's answer, not sent because the invoice was voided). The
invoices list shows **Sent on**: when the invoice first reached the mail server. **Send again**
e-mails it once more to the current addresses (useful after correcting a billing e-mail); it is
audited (`billing.invoice_sent`). A voided invoice is not sent, and with no billing e-mail and no
active director there is nobody to send to: the page says so. **Download PDF** gives the invoice
as a file in your own language; directors download their facility's invoices and credit notes from
**Documents to download** or from the document's own page. A credit note's page has the same
**Download PDF**, **Sent by e-mail** and **Send again**.

An operator without a VAT number prints **Not registered for VAT** instead of "VAT 0 %". With a
VAT number and a rate of 0, documents print "VAT 0 %" and the VAT number.

## Billing details

### Billing is ready only with the operator's details

An invoice keeps the operator's details for good, so no invoice is issued until **Operator
settings** has the operator's name, address, fiscal number (NUI), IBAN and – while VAT is charged
– the VAT number. Until then:

- the **Overview** shows **Billing is not ready** with the missing settings and a link to them;
- starting a paid subscription, **End the trial now** and **Invoice the current period** are not
  offered (a trial can still be started), and the server refuses any action that would issue an
  invoice with the list of missing settings – also **Reactivate** when that would start a new
  period with its invoice;
- money received is never refused: recording a payment, a credit note that settles an invoice and
  a void always go through. When that lifts a suspension for non-payment whose period ended, the
  subscription is active (or "payment overdue") again at once, and its next period – starting on
  that day, as it would have – is started and invoiced by the subscription worker once the
  settings are complete;
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
date; its directors are told and the invoice is e-mailed again as an overdue reminder – also when
they had been told of that overdue invoice before it was paid. It is never suspended by the
reversal itself – the subscription worker does that once the grace period is over, as for any
overdue invoice. A subscription that is already "payment overdue" keeps its grace period (it never
gets shorter: an administrator may have given a fresh one on reactivating), and the reopened
invoice is e-mailed with the next overdue reminder if it was not sent in that period yet.
Clinical work, sign-in and existing accounts are never affected (hazard H74).

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
  are made outside Pacient, by bank transfer; once it is made, **Record refund** on the invoice
  page (amount – at most what is to refund –, day and bank reference; your password is asked
  again). It is kept in the facility's internal history and audited, "to refund" goes down by it,
  and the facility's directors see **Refunded on …** on the invoice. The invoice and its payments
  do not change;
- is e-mailed with the invoice's recipients – the e-mail says what the invoice asks for afterwards:
  what is still to pay, that it is settled, or the amount to be refunded (only while some is) –
  and the facility's directors are notified and see it next to their invoices (**Subscription and
  invoices › Credit notes**), printable like an invoice and as a PDF;
- can never be changed or deleted (the database refuses). A mistake in a credit note is corrected
  by another document, never by editing it.

**Voiding** is only for a mistake noticed straight away: an invoice issued in the current month in
Kosovo, without any payment (also one reversed since) or credit note, and not yet e-mailed to the
customer (no e-mail with it went out). Otherwise Pacient refuses and asks for a credit note
instead. An e-mail with the invoice still waiting to be sent does not prevent the void: it is
withdrawn with it and never sent.

Reversing a payment, issuing a credit note, recording a refund and voiding ask for your password
again (in a dialog that appears by itself). Every payment, reversal, credit note and refund is
recorded in the administrative audit with its amount, in the same transaction as the change.
Changes of the same invoice made at the same moment – two payments, a payment and a reversal, or a
payment while the subscription worker sends an overdue reminder – wait for each other and never
work from the same figures.

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

Refunds recorded on invoices are not in these files (they are money given back outside Pacient,
in the bank's records); the invoices file shows what was paid and credited on each invoice.

The files hold business data of the operator's customers only – never anything about patients.
Each download asks for your password again and is recorded in the administrative audit with the
export and its period (nothing else). A period is at most one year.

## Operator settings

Company name, address, fiscal and VAT number, bank and IBAN, support and privacy contacts and the
support hours – printed on invoices, referred to by the legal texts and shown to users. A new IBAN
or bank, VAT rate or number, or invoice prefix asks for your password again before it is saved,
and a new IBAN or bank is announced at once to every other administrator (in the app and by
e-mail, with who and when); the overview shows **Bank details changed on …** for 14 days. If nobody
expected it, correct the details before the next invoice goes out and change the passwords of the
administrators. A new IBAN is checked before it is saved
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

The **service agreement** and the **data processing agreement** (the operator processes the
facilities' data on their behalf) are versioned on **Platform › Terms and privacy** like the terms
of use, each on its own tab: start a draft from the built-in template (Albanian, Serbian, English),
have it reviewed, publish. The templates cover processing only on the facility's instructions, the
categories of data and data subjects, the technical and organisational measures (referring to
SECURITY.md), the sub-processors (hosting, e-mail, SMS – in square brackets in the text for you to
fill in; there is no setting for them), help with a personal data breach within 72 hours, audits,
returning and deleting the data at the end, and that clinical access is never withheld for
non-payment. **Each template starts with a note asking for a lawyer's review, and publishing is
refused while the note is still in the text**: delete it once the text is reviewed. The public pages
are `/legal/service-agreement` and `/legal/dpa`.

A facility accepts each agreement once, through one of its directors, under **Subscription and
invoices › Agreements with the operator** (also when it has no subscription yet): they read the
text, type the signer's name and title, and confirm. The acceptance – version, language, signer,
the director's account, time, IP address and browser – is kept for good (the database refuses to
change or delete it) and audited with it. A second director, or the same version in another
language, records nothing new. A new version that asks for acceptance is asked again; one for
information only is not asked of facilities that accepted an earlier version, but a facility that
never accepted accepts the current one – the same rule as for the terms of use.

**Nothing is blocked by a missing acceptance.** Until one of them accepts, the facility's directors
see a notice with a link; nobody else sees anything, and the agreements are never part of the check
of the terms of use at sign-in (hazards H74 and H75 in [CLINICAL-SAFETY.md](CLINICAL-SAFETY.md)).

You see:

- on the **Overview**, the customers (active facilities whose subscription has not ended) that have
  not accepted the current agreements, or a reminder while an agreement is not published;
- on **Terms and privacy**, per agreement, how many customers are up to date, which have not
  accepted yet, and which facilities accepted a version (who signed, with which title, when);
- on each **facility's page**, its acceptances.

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

The directors and IT support of a facility write to the operator under **Contact the operator**:
billing and invoices, accounts and access, a technical problem, data protection, a security
incident, or something else. Requests are numbered per year (`REQ-2026-00001`) and are a
conversation, without attachments. **They are never about a patient**: a subject or message with a
10-digit number (a personal number) is refused, and every form says not to include patient
information – never ask for it in an answer either. The facility's directors and IT support see all
of their facility's requests, and only those.

Every administrator gets an important notification of a new request (also by e-mail, unless they
turned e-mail notifications off). A **security incident** is of high priority and is e-mailed to
every administrator at once, also to those who turned e-mail off. Notifications and e-mails name the
reference and the facility, never the subject or the text.

**Customers and subscriptions › Requests** lists every facility's requests, unresolved and high
priority first, filtered by status, category and facility; the **Overview** shows how many are open,
waiting for the facility, and of high priority. On a request, **answer** – the person who asked is
notified, and the facility sees the answer as from "the operator", without your name – and choose
the status it leaves: **waiting for the facility**, **resolved**, or as it is. The status can also
be changed on its own (the person who asked is told when it is resolved). The first answer is
recorded as the time of the first response. When the facility writes again, a request that was
waiting for it or resolved is open again, and the administrators are notified. Every request,
message and status change is audited in the same transaction, with the reference, category and
statuses only – not the text.

The support e-mail, phone and **support hours** (operator settings) are shown in the footer, on the
sign-in page, in the directors' subscription notices and on the public help page `/help`, which also
says to call 112 in an emergency and what the operator can and cannot see.

## Alerts and background jobs

The API runs about 25 **background jobs** – e-mail and SMS delivery, escalation of unanswered
results, reminders, the subscription lifecycle, data retention and others. Each run is recorded
(when, whether it worked, counts and a short error that never names a person; kept 30 days).
**System health › Background jobs** lists every job with its last run, last success and last
error. A job is **stalled** when it has had no successful run for three of its intervals (counted
from the start of the API if that is later, so a restart is not a stall); "Not started here" means
it is switched off on this server (for example SMS without a provider).

A **watchdog** looks every 10 minutes and raises an **alert** for each condition the operator must
act on, and resolves it by itself once the condition is gone:

| Alert                          | When                                                                          | What to do                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A background job has stopped   | No successful run for three intervals (critical for e-mail, SMS, escalations) | Read its last error on System health, check the API log (`docker compose --env-file .env.vps -f deploy/compose.vps.yml logs api`), restart the API |
| E-mails could not be delivered | A message was given up in the last 24 hours                                   | **System health › Recent failures**: a wrong address, or the mail server refusing                                                                  |
| E-mails are waiting to be sent | A message due for more than 30 minutes has not gone out (critical)            | Check `SMTP_URL` and the mail provider; without e-mail nobody can be invited or reset a password                                                   |
| Text messages – the same two   | As for e-mail (a warning only while no SMS provider is configured)            | Check the SMS provider account, or stop collecting phone numbers                                                                                   |
| No recent database backup      | No backup reported for 26 hours (only with `OPS_HEARTBEAT_TOKEN`)             | `systemctl status pacienti-backup.timer`, `journalctl -u pacienti-backup`                                                                          |
| Invoices cannot be issued      | The subscription worker could not invoice: operator settings incomplete       | Complete **Operator settings**; the waiting invoices are issued at its next run                                                                    |

Open alerts are listed at the top of the **Overview**, critical first, with what to do. When an
alert is raised every active administrator gets an important notification and an e-mail – at most
once per condition every 6 hours while it stays open, so a lasting problem is repeated, a
flickering one is not. Raising and resolving are recorded under **Administrative actions ›
Platform** (by the system). Alerts carry counts, times and job names only – never patient data or
e-mail addresses. The HTTPS certificate is not watched by the API (the proxy holds it): let the
external uptime check watch it ([GO-LIVE.md](GO-LIVE.md#monitoring-and-heartbeats)).

**Backups** on System health shows the last backup the server reported, with its size and
duration, once `OPS_HEARTBEAT_TOKEN` is set ([GO-LIVE.md](GO-LIVE.md#6-backups--the-same-day));
without it the card says how to turn it on.

**E-mail delivery** (System health, administrators only): **Send a test e-mail** sends one message
to your own address through the same queue and mail server as every other e-mail (once a minute;
recorded under Administrative actions). It should arrive within a minute and not in the spam
folder; if it does not, check the domain's records ([GO-LIVE.md](GO-LIVE.md#e-mail)). **Recent
failures** lists the last 50 messages given up or being retried, with the address shortened
(`j***@example.org`), the kind of message, the attempts and the mail server's answer – never the
subject or the text. Replies to any e-mail of Pacient go to the support address of the
**Operator settings** (when set), not to the no-reply sender.

With Prometheus, `pacient_worker_last_success_timestamp_seconds` and the `PacientWorkerStalled`
rule report the same stalls, also when the watchdog itself has stopped
([deploy/monitoring/README.md](../deploy/monitoring/README.md)).

## Recovering an administrator

An administrator who lost the password **and** the authenticator app and recovery codes cannot be
helped in the portal by themselves; another administrator can reset their two-step sign-in under
**Users** (after making sure, in person or on a known phone number, that it is really them) and
they then use **Forgot your password?**. When there is no other administrator who can sign in, the
owner of the installation recovers the account on the server:

```bash
deploy/recover-admin.sh admin@example.org
```

For an existing, activated and enabled administrator only (a disabled one is enabled by another
administrator first; one who never activated gets the invitation again). In one step the old
password stops working, the authenticator app, recovery codes and passkeys are removed, earlier
reset links and every session end, and a single-use password reset link, valid 24 hours, is
written only to `~/pacienti-private/recover.txt` (folder 0700, file 0600) – never printed, logged
or e-mailed. Make sure who you are giving it to, hand it over privately, then delete the file. The
administrator chooses a new password with it and sets up two-step sign-in again at the next
sign-in. The recovery is audited as an owner-authorized recovery (by the system, in the account's
history and under **Administrative actions**), and every other active administrator is told in
the app and by e-mail. It is refused for any other account, and then nothing changes and no file
is left behind; an earlier `recover.txt` is never overwritten.

## Before the first customer

1. **Operator settings** – complete them.
2. **Terms and privacy** – the terms of use, privacy notice, service agreement and data
   processing agreement reviewed by a lawyer, published in all three languages.
3. **Plans** – names, prices and seat limits.
4. E-mail works: **System health › Send a test e-mail** arrives, and not in the spam folder.
5. A second administrator exists.
6. Backups run and a restore was verified ([GO-LIVE.md](GO-LIVE.md), step 6).
