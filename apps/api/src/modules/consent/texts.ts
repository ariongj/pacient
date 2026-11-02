/**
 * Plain-language explanations shown to patients and staff. Every consent record stores the
 * version of the wording that was shown, so a decision can be interpreted later even after the
 * explanation changes. Change the version whenever the meaning changes.
 */
export const CONSENT_WORDING_VERSION = '2026-1';

export type ConsentType = 'CROSS_FACILITY_SHARING' | 'RESEARCH' | 'TREATMENT';

export interface ConsentText {
  type: ConsentType;
  version: string;
  title: string;
  summary: string;
  details: string[];
  /** What happens when no decision has been recorded. */
  defaultDecision: 'GRANTED' | 'NOT_GRANTED';
  /** Whether patients (or their guardians) manage this consent in the portal. */
  patientManaged: boolean;
}

export const CONSENT_TEXTS: ConsentText[] = [
  {
    type: 'CROSS_FACILITY_SHARING',
    version: CONSENT_WORDING_VERSION,
    title: 'Sharing my record when I am referred to another facility',
    summary:
      'When your doctor refers you to another hospital or clinic, the doctors there can see the referral summary and, once they accept you, your record – so they can treat you safely.',
    details: [
      'This is on unless you turn it off.',
      'If you turn it off, your doctor must talk to you and record your agreement before referring you elsewhere.',
      'Care within the facility where you are registered is not affected.',
      'In an emergency, doctors at your own facility can still open your record to protect your life; every such access is reviewed and shown to you.',
    ],
    defaultDecision: 'GRANTED',
    patientManaged: true,
  },
  {
    type: 'RESEARCH',
    version: CONSENT_WORDING_VERSION,
    title: 'Use of my data for approved research',
    summary:
      'Information from your record, with your name and identity numbers removed, may be used in health research that an ethics committee has approved.',
    details: [
      'This is off unless you turn it on.',
      'Researchers never receive your name, national ID, address or contact details.',
      'You can change your mind at any time; data already used in a finished study cannot be taken back.',
      'Saying no does not change your care in any way.',
    ],
    defaultDecision: 'NOT_GRANTED',
    patientManaged: true,
  },
  {
    type: 'TREATMENT',
    version: CONSENT_WORDING_VERSION,
    title: 'Consent to a treatment or procedure',
    summary:
      'Before a procedure your doctor explains what it involves, the benefits, the risks and the alternatives. Your decision is recorded here.',
    details: [
      'Recorded by your doctor, in person or with a signed form.',
      'You can withdraw your consent before the procedure starts.',
    ],
    defaultDecision: 'NOT_GRANTED',
    patientManaged: false,
  },
];

export const textFor = (type: ConsentType) => CONSENT_TEXTS.find((t) => t.type === type)!;
