import type { Role } from './api/types';
import type { IconName } from './components/icons';

/**
 * The application's navigation in one place: every role has a home page and a handful of main
 * modules, each with its sub-modules (pages). The sidebar, the page finder, the breadcrumb and the
 * "All modules" page are all drawn from this registry – add a page here and it appears everywhere.
 *
 * Titles and labels are English source texts, translated where they are shown (the translation
 * check reads this file too).
 */
export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

export interface NavModule {
  id: string;
  title: string;
  icon: IconName;
  /** One line under the title on the "All modules" page. */
  summary: string;
  items: NavItem[];
}

export interface RoleNav {
  home: NavItem;
  modules: NavModule[];
}

/** Pages shared by several roles (a role may show one under another label). */
const P = {
  tasks: { to: '/tasks', label: 'Care tasks', icon: 'clipboard' },
  patientMessages: { to: '/messages', label: 'Patient messages', icon: 'message' },
  waitingLists: { to: '/waiting-lists', label: 'Waiting lists', icon: 'calendar' },
  certificates: { to: '/certificates', label: 'Medical certificates', icon: 'clipboard' },
  ePrescriptions: { to: '/e-prescriptions', label: 'E-prescriptions', icon: 'pill' },
  interactions: { to: '/tools/interactions', label: 'Interaction checker', icon: 'pill' },
  deaths: { to: '/deaths', label: 'Death certificates', icon: 'clipboard' },
  wards: { to: '/wards', label: 'Wards & beds', icon: 'building' },
  earlyWarning: { to: '/wards/early-warning', label: 'Early warning (NEWS2)', icon: 'alert' },
  sepsis: { to: '/sepsis', label: 'Sepsis', icon: 'alert' },
  nutrition: { to: '/nutrition', label: 'Nutrition', icon: 'clipboard' },
  infection: { to: '/infection', label: 'Infection prevention', icon: 'shield' },
  births: { to: '/births', label: 'Births', icon: 'user' },
  identities: { to: '/identities', label: 'Temporary identities', icon: 'clipboard' },
  ed: { to: '/ed', label: 'Emergency department', icon: 'alert' },
  ems: { to: '/ems', label: 'Ambulance service', icon: 'activity' },
  theatre: { to: '/theatre', label: 'Operating theatres', icon: 'activity' },
  bloodBank: { to: '/blood-bank', label: 'Blood bank', icon: 'flask' },
  imaging: { to: '/imaging', label: 'Imaging', icon: 'eye' },
  registers: { to: '/registers', label: 'Disease registers', icon: 'activity' },
  screening: { to: '/screening', label: 'Cancer screening', icon: 'shield' },
  maternity: { to: '/maternity', label: 'Antenatal care', icon: 'user' },
  vaccinationsDue: { to: '/vaccinations/due', label: 'Vaccinations due', icon: 'syringe' },
  remote: { to: '/remote-monitoring', label: 'Remote monitoring', icon: 'activity' },
  proms: { to: '/proms', label: 'Questionnaires', icon: 'clipboard' },
  homeCare: { to: '/home-care', label: 'Home care', icon: 'home' },
  dialysis: { to: '/dialysis', label: 'Dialysis', icon: 'activity' },
  oncology: { to: '/oncology', label: 'Cancer registry', icon: 'clipboard' },
  mentalHealth: { to: '/mental-health', label: 'Mental health safeguards', icon: 'shield' },
  bloodDonors: { to: '/blood-donors', label: 'Blood donors', icon: 'flask' },
  equipment: { to: '/equipment', label: 'Medical equipment', icon: 'settings' },
  downtime: { to: '/downtime', label: 'Downtime kit', icon: 'shield' },
  channels: { to: '/channels', label: 'Team channels', icon: 'hash' },
  incidents: { to: '/incidents', label: 'Report an incident', icon: 'alert' },
  rosters: { to: '/rosters', label: 'Rosters and on-call', icon: 'calendar' },
  support: { to: '/support', label: 'IT support', icon: 'settings' },
  complaintsMine: { to: '/complaints', label: 'Complaints assigned to me', icon: 'message' },
  complaints: { to: '/complaints', label: 'Complaints & feedback', icon: 'message' },
  stock: { to: '/pharmacy/stock', label: 'Stock', icon: 'clipboard' },
  billing: { to: '/billing', label: 'Billing & insurance', icon: 'clipboard' },
  lab: { to: '/lab', label: 'Laboratory worklist', icon: 'flask' },
  terminology: { to: '/terminology', label: 'Terminology', icon: 'clipboard' },
  accessReviews: { to: '/access-reviews', label: 'Access reviews', icon: 'shield' },
  licences: { to: '/licences', label: 'Staff licences', icon: 'shield' },
  privacy: { to: '/privacy', label: 'Data protection', icon: 'shield' },
  surveillance: { to: '/surveillance', label: 'Notifiable diseases', icon: 'alert' },
} satisfies Record<string, NavItem>;

const as = (item: NavItem, label: string): NavItem => ({ ...item, label });

/** Modules that look the same for doctors and nurses. */
const WARDS: NavModule = {
  id: 'wards',
  title: 'Hospital wards',
  icon: 'building',
  summary: 'Beds, early warning scores, sepsis, nutrition, infection control and births.',
  items: [P.wards, P.earlyWarning, P.sepsis, P.nutrition, P.infection, P.births, P.identities],
};
const EMERGENCY: NavModule = {
  id: 'emergency',
  title: 'Emergency and surgery',
  icon: 'alert',
  summary: 'Emergency department, ambulance service, operating theatres and the blood bank.',
  items: [P.ed, P.ems, P.theatre, P.bloodBank],
};
const DIAGNOSTICS: NavModule = {
  id: 'diagnostics',
  title: 'Diagnostics and medicines',
  icon: 'eye',
  summary: 'Imaging and the medicine interaction checker.',
  items: [P.imaging, P.interactions],
};
const PROGRAMMES: NavItem[] = [
  P.registers,
  P.screening,
  P.maternity,
  P.remote,
  P.proms,
  P.homeCare,
];
const UNITS: NavModule = {
  id: 'units',
  title: 'Specialist units',
  icon: 'activity',
  summary: 'Dialysis, the cancer registry, mental health safeguards and blood donors.',
  items: [P.dialysis, P.oncology, P.mentalHealth, P.bloodDonors],
};
const TEAM_SUMMARY = 'Channels, rosters, incident reports and help from IT support.';

export const NAVIGATION: Record<Role, RoleNav> = {
  PATIENT: {
    home: { to: '/portal', label: 'Overview', icon: 'home', end: true },
    modules: [
      {
        id: 'record',
        title: 'My record',
        icon: 'history',
        summary:
          'Your history, results, images, vaccinations, documents, hospital stays and emergency visits.',
        items: [
          { to: '/portal/history', label: 'Medical history', icon: 'history' },
          { to: '/portal/results', label: 'Test results', icon: 'flask' },
          { to: '/portal/imaging', label: 'Imaging', icon: 'eye' },
          { to: '/portal/vaccinations', label: 'Vaccinations', icon: 'syringe' },
          { to: '/portal/documents', label: 'Documents', icon: 'clipboard' },
          { to: '/portal/stays', label: 'Hospital stays', icon: 'building' },
          { to: '/portal/emergency', label: 'Emergency visits', icon: 'alert' },
        ],
      },
      {
        id: 'care',
        title: 'Appointments and care',
        icon: 'calendar',
        summary: 'Appointments, referrals, waiting lists, home visits and messages to your doctor.',
        items: [
          { to: '/portal/appointments', label: 'Appointments', icon: 'calendar' },
          { to: '/portal/referrals', label: 'Referrals', icon: 'share' },
          { to: '/portal/waiting-lists', label: 'Waiting lists', icon: 'calendar' },
          { to: '/portal/home-visits', label: 'Home visits', icon: 'home' },
          { to: '/portal/messages', label: 'Messages', icon: 'message' },
        ],
      },
      {
        id: 'paperwork',
        title: 'Prescriptions and paperwork',
        icon: 'pill',
        summary: 'E-prescriptions, medical certificates and bills.',
        items: [
          { to: '/portal/e-prescriptions', label: 'E-prescriptions', icon: 'pill' },
          { to: '/portal/certificates', label: 'Medical certificates', icon: 'clipboard' },
          { to: '/portal/billing', label: 'Bills & payments', icon: 'clipboard' },
        ],
      },
      {
        id: 'programmes',
        title: 'Health programmes',
        icon: 'activity',
        summary: 'Home readings, questionnaires, screening, pregnancy and blood donation.',
        items: [
          { to: '/portal/readings', label: 'Home readings', icon: 'activity' },
          { to: '/portal/questionnaires', label: 'Questionnaires', icon: 'clipboard' },
          { to: '/portal/screening', label: 'Cancer screening', icon: 'shield' },
          { to: '/portal/pregnancy', label: 'My pregnancy', icon: 'user' },
          { to: '/portal/blood-donation', label: 'Blood donation', icon: 'flask' },
        ],
      },
      {
        id: 'privacy',
        title: 'Privacy and account',
        icon: 'shield',
        summary: 'Consent, who viewed your record, your wishes, complaints and your details.',
        items: [
          { to: '/portal/consents', label: 'Privacy & consent', icon: 'shield' },
          { to: '/portal/access-log', label: 'Who viewed my record', icon: 'eye' },
          { to: '/portal/wishes', label: 'Organ donation & wishes', icon: 'user' },
          { to: '/portal/complaints', label: 'Complaints & feedback', icon: 'message' },
          { to: '/portal/account', label: 'My details', icon: 'user' },
        ],
      },
    ],
  },

  DOCTOR: {
    home: { to: '/doctor', label: 'Worklist', icon: 'activity', end: true },
    modules: [
      {
        id: 'patients',
        title: 'Patients',
        icon: 'users',
        summary: 'Your patients, schedule, care tasks, referrals, waiting lists and messages.',
        items: [
          { to: '/doctor/patients', label: 'Patients', icon: 'users' },
          { to: '/doctor/schedule', label: 'Schedule', icon: 'calendar' },
          P.tasks,
          { to: '/doctor/referrals', label: 'Referrals', icon: 'share' },
          P.waitingLists,
          P.patientMessages,
        ],
      },
      {
        id: 'documents',
        title: 'Prescriptions and certificates',
        icon: 'pill',
        summary: 'E-prescriptions, medical certificates and death certificates.',
        items: [P.ePrescriptions, P.certificates, P.deaths],
      },
      WARDS,
      EMERGENCY,
      DIAGNOSTICS,
      {
        id: 'programmes',
        title: 'Care programmes',
        icon: 'shield',
        summary: 'Disease registers, screening, antenatal care, home monitoring and home care.',
        items: PROGRAMMES,
      },
      UNITS,
      {
        id: 'mywork',
        title: 'My work',
        icon: 'calendar',
        summary: 'Consulting hours, cover and absence, rosters and complaints assigned to you.',
        items: [
          { to: '/doctor/availability', label: 'My consulting hours', icon: 'calendar' },
          { to: '/doctor/cover', label: 'Cover & absence', icon: 'users' },
          P.rosters,
          P.complaintsMine,
        ],
      },
      {
        id: 'team',
        title: 'Team and support',
        icon: 'hash',
        summary: 'Channels, incident reports, equipment, the downtime kit and IT support.',
        items: [P.channels, P.incidents, P.equipment, P.downtime, P.support],
      },
    ],
  },

  NURSE: {
    home: { to: '/nurse', label: 'Shift overview', icon: 'activity', end: true },
    modules: [
      {
        id: 'patients',
        title: 'Patients',
        icon: 'users',
        summary: 'Patients, the clinic schedule, care tasks, vaccinations due and messages.',
        items: [
          { to: '/nurse/patients', label: 'Patients', icon: 'users' },
          { to: '/nurse/schedule', label: 'Clinic schedule', icon: 'calendar' },
          P.tasks,
          P.vaccinationsDue,
          P.patientMessages,
        ],
      },
      WARDS,
      EMERGENCY,
      DIAGNOSTICS,
      {
        id: 'programmes',
        title: 'Care programmes',
        icon: 'shield',
        summary: 'Disease registers, screening, antenatal care, home monitoring and home care.',
        items: PROGRAMMES,
      },
      UNITS,
      {
        id: 'team',
        title: 'Team and support',
        icon: 'hash',
        summary: 'Channels, rosters, incident reports, equipment, the downtime kit and IT support.',
        items: [
          P.channels,
          P.rosters,
          P.incidents,
          P.complaintsMine,
          P.equipment,
          P.downtime,
          P.support,
        ],
      },
    ],
  },

  PHARMACIST: {
    home: { to: '/pharmacy', label: 'Verification queue', icon: 'pill', end: true },
    modules: [
      {
        id: 'pharmacy',
        title: 'Pharmacy',
        icon: 'pill',
        summary: 'Stock, e-prescriptions, restricted antibiotics and the interaction checker.',
        items: [
          P.stock,
          P.ePrescriptions,
          as(P.infection, 'Restricted antibiotics'),
          as(P.interactions, 'Interaction checker'),
        ],
      },
      {
        id: 'team',
        title: 'Team and support',
        icon: 'hash',
        summary: TEAM_SUMMARY,
        items: [P.channels, P.rosters, P.incidents, P.complaintsMine, P.support],
      },
    ],
  },

  RECEPTION: {
    home: { to: '/reception', label: 'Today', icon: 'desk', end: true },
    modules: [
      {
        id: 'frontdesk',
        title: 'Front desk',
        icon: 'desk',
        summary: 'Patients, appointments, waiting lists and billing.',
        items: [
          { to: '/reception/patients', label: 'Patients', icon: 'users' },
          { to: '/reception/appointments', label: 'Appointments', icon: 'calendar' },
          P.waitingLists,
          P.billing,
        ],
      },
      {
        id: 'hospital',
        title: 'Hospital',
        icon: 'building',
        summary: 'Emergency arrivals, beds, births and temporary identities.',
        items: [as(P.ed, 'Emergency arrivals'), P.wards, P.births, P.identities],
      },
      {
        id: 'programmes',
        title: 'Care programmes',
        icon: 'shield',
        summary: 'Vaccinations due and blood donors.',
        items: [P.vaccinationsDue, P.bloodDonors],
      },
      {
        id: 'team',
        title: 'Team and support',
        icon: 'hash',
        summary:
          'Complaints, channels, rosters, incident reports, the downtime kit and IT support.',
        items: [
          as(P.complaints, 'Complaints'),
          P.channels,
          P.rosters,
          P.incidents,
          P.downtime,
          P.support,
        ],
      },
    ],
  },

  LAB_TECHNICIAN: {
    home: { ...P.lab, end: true },
    modules: [
      {
        id: 'laboratory',
        title: 'Laboratory',
        icon: 'flask',
        summary: 'Code systems and mappings used by the laboratory.',
        items: [P.terminology],
      },
      {
        id: 'team',
        title: 'Team and support',
        icon: 'hash',
        summary: TEAM_SUMMARY,
        items: [P.channels, P.rosters, P.incidents, P.support],
      },
    ],
  },

  IT_SUPPORT: {
    home: { to: '/support', label: 'Support desk', icon: 'settings', end: true },
    modules: [
      {
        id: 'team',
        title: 'Team and support',
        icon: 'hash',
        summary: 'Channels and incident reports.',
        items: [P.channels, P.incidents],
      },
    ],
  },

  DIRECTOR: {
    home: { to: '/director', label: 'Dashboard', icon: 'chart', end: true },
    modules: [
      {
        id: 'management',
        title: 'Facility management',
        icon: 'building',
        summary: 'Reports, staff, units, rosters, billing, stock, equipment and the laboratory.',
        items: [
          { to: '/director/reports', label: 'Reports', icon: 'activity' },
          { to: '/director/staff', label: 'Staff', icon: 'users' },
          { to: '/director/units', label: 'Wards & units', icon: 'building' },
          P.rosters,
          as(P.billing, 'Billing & claims'),
          as(P.stock, 'Pharmacy stock'),
          P.equipment,
          as(P.lab, 'Laboratory turnaround'),
          { to: '/director/integrations', label: 'Lab connections', icon: 'flask' },
        ],
      },
      {
        id: 'patients',
        title: 'Patient administration',
        icon: 'users',
        summary: 'Registered patients, duplicates, identities, referrals, waiting lists and beds.',
        items: [
          { to: '/director/patients', label: 'Registered patients', icon: 'user' },
          { to: '/director/duplicates', label: 'Duplicate records', icon: 'user' },
          P.identities,
          { to: '/director/referrals', label: 'Referrals', icon: 'share' },
          P.waitingLists,
          as(P.wards, 'Bed board'),
        ],
      },
      {
        id: 'services',
        title: 'Clinical services',
        icon: 'activity',
        summary:
          'Figures for antenatal care, screening, prescriptions, ambulance and home services.',
        items: [
          P.maternity,
          P.screening,
          P.ePrescriptions,
          P.certificates,
          P.ems,
          P.homeCare,
          P.remote,
          P.proms,
          P.bloodBank,
        ],
      },
      UNITS,
      {
        id: 'quality',
        title: 'Quality and safety',
        icon: 'alert',
        summary: 'Incidents, complaints, infections, sepsis, deaths and disease reporting.',
        items: [
          as(P.incidents, 'Safety incidents'),
          P.complaints,
          P.infection,
          P.sepsis,
          as(P.deaths, 'Deaths'),
          P.surveillance,
          P.registers,
          { to: '/director/vaccination', label: 'Vaccination coverage', icon: 'syringe' },
        ],
      },
      {
        id: 'governance',
        title: 'Governance and privacy',
        icon: 'shield',
        summary: 'Access reviews, licences, emergency access, audit, data protection and downtime.',
        items: [
          P.accessReviews,
          P.licences,
          { to: '/director/emergency-access', label: 'Emergency access review', icon: 'alert' },
          { to: '/director/audit', label: 'Audit review', icon: 'shield' },
          P.privacy,
          P.terminology,
          P.downtime,
        ],
      },
      {
        id: 'communication',
        title: 'Communication',
        icon: 'megaphone',
        summary: 'Team channels, announcements and IT support.',
        items: [
          P.channels,
          { to: '/director/announcements', label: 'Announcements', icon: 'megaphone' },
          P.support,
        ],
      },
    ],
  },

  MINISTRY: {
    home: { to: '/ministry', label: 'National overview', icon: 'chart', end: true },
    modules: [
      {
        id: 'system',
        title: 'Health system',
        icon: 'building',
        summary: 'Reports, facilities, officials, medicines, waiting times, ambulances, equipment.',
        items: [
          { to: '/ministry/reports', label: 'Reports', icon: 'activity' },
          { to: '/ministry/facilities', label: 'Facilities', icon: 'building' },
          { to: '/ministry/staff', label: 'Directors & officials', icon: 'users' },
          { to: '/ministry/stock', label: 'Medicine availability', icon: 'pill' },
          { to: '/ministry/catalogue', label: 'Medicine catalogue', icon: 'pill' },
          as(P.waitingLists, 'Waiting times'),
          as(P.ems, 'Ambulance response times'),
          as(P.equipment, 'Critical equipment'),
        ],
      },
      {
        id: 'publichealth',
        title: 'Public health',
        icon: 'activity',
        summary:
          'Surveillance, vaccination, mortality, chronic disease, maternal health, screening.',
        items: [
          as(P.surveillance, 'Disease surveillance'),
          { to: '/ministry/vaccination', label: 'Vaccination coverage', icon: 'syringe' },
          { ...as(P.deaths, 'Mortality'), icon: 'chart' },
          as(P.registers, 'Chronic disease registers'),
          as(P.maternity, 'Maternal health'),
          as(P.screening, 'Screening coverage'),
          as(P.infection, 'Healthcare-associated infections'),
        ],
      },
      {
        id: 'registries',
        title: 'National registries',
        icon: 'clipboard',
        summary: 'Cancer, organ donation, blood donors, dialysis, mental health, e-prescriptions.',
        items: [
          P.oncology,
          { to: '/organ-donation', label: 'Organ donation registry', icon: 'user' },
          P.bloodDonors,
          P.dialysis,
          P.mentalHealth,
          P.ePrescriptions,
        ],
      },
      {
        id: 'oversight',
        title: 'Quality and oversight',
        icon: 'shield',
        summary: 'Incidents, complaints, licences, emergency access, audit and data protection.',
        items: [
          as(P.incidents, 'Safety incidents'),
          P.complaints,
          as(P.licences, 'Professional licences'),
          { to: '/ministry/emergency-access', label: 'Emergency access', icon: 'alert' },
          { to: '/ministry/audit', label: 'Audit review', icon: 'shield' },
          P.accessReviews,
          P.privacy,
        ],
      },
      {
        id: 'data',
        title: 'Data and standards',
        icon: 'chart',
        summary: 'Open data, code systems, the interaction database, partner systems and the API.',
        items: [
          { to: '/open-data', label: 'Open data (public)', icon: 'chart' },
          P.terminology,
          as(P.interactions, 'Drug interaction database'),
          { to: '/ministry/partners', label: 'Partner systems (API)', icon: 'share' },
          { to: '/developers', label: 'API documentation', icon: 'settings' },
          { to: '/ministry/system', label: 'System health', icon: 'activity' },
        ],
      },
      {
        id: 'communication',
        title: 'Communication',
        icon: 'megaphone',
        summary: 'Team channels, announcements, rosters and IT support.',
        items: [
          P.channels,
          { to: '/ministry/announcements', label: 'Announcements', icon: 'megaphone' },
          P.rosters,
          P.support,
        ],
      },
    ],
  },
};

/** Every page of a role in menu order (home first). */
export function allItems(nav: RoleNav): NavItem[] {
  return [nav.home, ...nav.modules.flatMap((m) => m.items)];
}

/**
 * The module and page a path belongs to: the page with the longest matching path wins, so
 * /doctor/patients/123 belongs to "Patients" and /wards/early-warning to its own entry.
 */
export function locate(
  nav: RoleNav,
  pathname: string,
): { module: NavModule | null; item: NavItem } | null {
  let best: { module: NavModule | null; item: NavItem } | null = null;
  const consider = (module: NavModule | null, item: NavItem) => {
    const exact = pathname === item.to;
    const inside = !item.end && pathname.startsWith(`${item.to}/`);
    if ((exact || inside) && (!best || item.to.length > best.item.to.length)) {
      best = { module, item };
    }
  };
  consider(null, nav.home);
  for (const m of nav.modules) for (const item of m.items) consider(m, item);
  return best;
}
