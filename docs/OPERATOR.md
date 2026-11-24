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
| **Customers and subscriptions › Invoices and payments** | All invoices; record a payment, void, print                                    |
| **Customers and subscriptions › Plans**                 | What facilities can subscribe to, and at what price                            |
| **Users**                                               | Every account of the service                                                   |
| **Platform › Operator settings**                        | Company details, payment terms, VAT, trial and grace periods, notice to users  |
| **Platform › Terms and privacy**                        | Versions of the two legal texts, publishing, who accepted                      |
| **Platform › System health**                            | Database, e-mail and SMS queues, background workers                            |
| **Platform › Administrative actions**                   | Everything administrators did, by category                                     |

## Users

Search by name or e-mail; filter by role, facility and state (active, disabled, locked, waiting
for activation, without two-step sign-in).

- **Invite** staff of any facility, Ministry officials and other administrators. The person gets an
  activation link by e-mail (valid 72 hours). Doctors, nurses and pharmacists need their licence
  number. Patients are never invited here – their facility registers them.
- **Change** name, role, facility, specialty or licence number. A role or facility change is refused
  while the person still has patients in their care; the patients are handed over first.
- **Disable / enable**, **unlock** after too many failed sign-ins, **send a password reset**,
  **reset two-step sign-in** (the person sets it up again at the next sign-in and is notified), **sign out everywhere**, **send the invitation again**.

Every action asks for a reason where it matters, is written to the audit trail together with the
change, and appears in the account's history. An administrator cannot act on their own account
(use **Settings › Security**). For patient accounts only disable, enable, unlock, sign out and
password reset are offered; their personal details are kept by their facility.

Directors keep inviting and managing their own staff, as before.

## Subscriptions

A facility has at most one subscription. A facility without one – for example a public facility
run by the Ministry – works without limits.

**New customer** creates the facility, its subscription and the first director's invitation in one
step. An existing facility gets a subscription from its page.

| Status          | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| Trial           | Free for the trial period (operator settings, 30 days by default); nothing is invoiced |
| Active          | Invoiced at the start of every period (monthly or yearly)                              |
| Payment overdue | An invoice passed its due date                                                         |
| Suspended       | Unpaid for longer than the grace period (30 days by default), or suspended by hand     |
| Cancelled       | Ended, now or at the end of the paid period                                            |

What happens by itself (checked every six hours):

- a trial that ends becomes active and gets its first invoice;
- at the end of each period the subscription renews and the next invoice is issued;
- an invoice past its due date marks the subscription as overdue; after the grace period it is
  suspended;
- directors are told a week before a trial ends or a renewal, when an invoice is issued, overdue,
  and when the status changes.

By hand, on the facility's page: change plan, billing cycle, number of staff accounts (seats) or an
agreed price; start the paid subscription before the trial ends; suspend and reactivate; cancel
(now, or at the end of the period) and withdraw a cancellation; add an internal note. A change of
plan or price applies from the next invoice; to apply it now, void the invoice of the current
period and issue it again.

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

Pacient does not take card payments. Customers pay by bank transfer with the invoice number as
the reference, and the administrator **records the payment** (date, method, reference). When
nothing else is overdue, an overdue or suspended subscription is active again at once. An invoice
issued by mistake is **voided** with a reason; it keeps its number.

Directors see their plan, seats, history and invoices under **Facility management › Subscription
and invoices**, and can print every invoice.

## Operator settings

Company name, address, fiscal and VAT number, bank and IBAN, support and privacy contacts –
printed on invoices and referred to by the legal texts. Payment terms (days until an invoice is
due), VAT rate (0 when not VAT-registered), trial length and grace period apply to invoices and
subscriptions from then on; issued invoices do not change.

**Notice to users** shows one line to everyone who is signed in, for example planned maintenance,
until the time you set.

## Terms of use and privacy notice

Each text has versions, each version one text per language (Albanian, Serbian, English). Start a
draft from the built-in template, edit it, and publish. **The templates are drafts: have a lawyer
review them before you publish.** The operator's details must be filled in first, because the texts
refer to them.

A published version cannot be changed or deleted – publish a new version instead. When a version
asks for acceptance, every user accepts it at their next sign-in before continuing; the acceptance
(who, which version, when) is stored and listed under the version. Administrators are not asked.
The public pages `/terms` and `/privacy` always show the current version.

If the check for pending texts cannot be reached, the user is let in and asked next time: the
legal gate never stands between a clinician and a patient (hazard H75).

## Administrative actions and system health

**Administrative actions** lists what administrators did – accounts, subscriptions and invoices,
platform settings and legal texts – with the person, the target and the reason. It is part of the
same append-only audit trail as everything else.

**System health** shows the database, e-mail and SMS waiting or failed, and the background
workers. Check it after go-live and when someone reports a missing e-mail.

## Before the first customer

1. **Operator settings** – complete them.
2. **Terms and privacy** – reviewed by a lawyer, published in all three languages.
3. **Plans** – names, prices and seat limits.
4. E-mail works (send yourself an invitation or a password reset).
5. A second administrator exists.
6. Backups run and a restore was verified ([GO-LIVE.md](GO-LIVE.md), step 6).
