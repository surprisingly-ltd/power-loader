// Writes the demo's synthetic casework systems: 100 fictional cases and the people behind them, as static
// pages in four fictional systems, from a fixed seed. Nothing here is real: names are drawn from common
// lists, NI numbers start QQ (never issued), phones are in Ofcom's drama range (07700 900xxx), emails are at
// example.org and example.com, and addresses are in the fictional NS postcode area.
//
// Each system has a homepage (index.html), which its name in the header and its first nav item link to.
//
//   demo/cm/         Northshire Council Case Manager: My work (index.html), the work queue (queue.html, 25 a
//                    page), a page per case (case-1001.html …) and its case notes (notes-1001.html …)
//   demo/biv/        Benefits and Income Verification: every record by surname (index.html, 25 a page), and
//                    employment and income per person (income-NC-xxxx.html)
//   demo/harbour/    Harbour Homes partner portal: every tenancy (index.html, 25 a page), and a rent account
//                    per tenancy (tenancy-HH-xxxxx.html)
//   demo/intranet/   The council's staff intranet: Procedures (index.html) and the team's own rent support review
//                    procedure (rent-support-review.html), with a training example for each branch
//   demo/messages/   Customer Messages: the team inbox (index.html, 25 a page), every client (clients.html),
//                    a client overview per person (client/NC-xxxx.html) listing six
//                    messages, a page per message (message/NC-xxxx-1.html … -6.html) and the same messages as
//                    data (api/NC-xxxx.json). Only "Tell us about a change" online forms carry an effective
//                    date, a new weekly income or a tenancy end date, and the list doesn't say which they are.
//                    Partner organisations send referrals (urgent or routine; open, accepted or closed) and
//                    enquiries about them, as message/MSG-xxxxxx.html: the inbox shows neither which is which nor
//                    how urgent, so only opening each one tells. They come from their own seeded stream (SEED + 1),
//                    so every existing case, record, tenancy and message keeps its values.
//
// The pages are generated, not committed (see .gitignore): `pnpm demo`, `pnpm test`, `pnpm build:site` and
// tools/build-site.mjs write them first. Every value a profile reads is in the HTML as delivered; the only
// script is demo/assets/casework.js, which marks cases done in localStorage, opens and closes the tenancy page's
// accordion, and never changes the records.
//
// Usage: node tools/build-demo-systems.mjs            write the pages into demo/
//        node tools/build-demo-systems.mjs --check    build twice and compare, check the data is fictional,
//                                                     and that any pages on disk are the current ones
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const demoRoot = fileURLToPath(new URL('../demo/', import.meta.url));
export const SEED = 20261125;
export const CASE_COUNT = 100;
export const FIRST_CASE = 1001;
export const PAGE_SIZE = 25;
export const MESSAGES_PER_CLIENT = 6;
/** The folders the generator owns, under demo/. Everything in them is rewritten. */
export const SYSTEM_DIRS = ['cm', 'biv', 'harbour', 'messages', 'intranet'];
const TODAY = '2026-11-25';

// Cases with a planned quirk, so the demo can point at them. Every other case is consistent across systems.
export const QUIRKS = {
  // Harbour Homes still has the tenant's previous address: address and postcode conflict.
  address: [1003, 1018, 1036, 1052, 1071, 1090],
  // The income system spells the name differently: a name conflict, weak identity evidence.
  spelling: [1007, 1024, 1045, 1063, 1082],
  // The income record under the client's council reference is someone else (a reused reference, as client-2077).
  otherPerson: [1005, 1047, 1088],
  // The case was made from a phone call and has no Harbour Homes tenancy reference: the flow emails the client.
  noTenancyRef: [1009, 1030, 1066],
};

// ------------------------------------------------------------------ a seeded generator

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  return { next, int, pick, chance };
}

// ------------------------------------------------------------------ word lists (common names, made-up places)

const FEMALE = ['Amelia', 'Olivia', 'Sophie', 'Grace', 'Chloe', 'Hannah', 'Emily', 'Jessica', 'Lucy', 'Aisha', 'Fatima', 'Priya', 'Zainab', 'Agnieszka', 'Joanna', 'Ewa', 'Ioana', 'Leah', 'Rachel', 'Sarah', 'Karen', 'Michelle', 'Nicola', 'Claire', 'Danielle', 'Gemma', 'Kirsty', 'Bethany', 'Amara', 'Chiamaka', 'Mei', 'Yasmin', 'Holly', 'Megan', 'Stacey', 'Louise'];
const MALE = ['Oliver', 'Jack', 'Harry', 'Thomas', 'James', 'Daniel', 'Ryan', 'Liam', 'Connor', 'Mohammed', 'Ahmed', 'Imran', 'Tomasz', 'Piotr', 'Marek', 'Andrei', 'Kwame', 'Samuel', 'David', 'Mark', 'Paul', 'Steven', 'Craig', 'Dean', 'Lee', 'Gareth', 'Jamal', 'Ravi', 'Arjun', 'Wei', 'Callum', 'Kieran', 'Nathan', 'Aaron', 'Joseph', 'Michael'];
const SURNAMES = ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Patel', 'Robinson', 'Wright', 'Thompson', 'Evans', 'Walker', 'White', 'Roberts', 'Green', 'Hall', 'Thomas', 'Clarke', 'Jackson', 'Wood', 'Harris', 'Edwards', 'Turner', 'Martin', 'Cooper', 'Hill', 'Ward', 'Hughes', 'Moore', 'Clark', 'King', 'Harrison', 'Lewis', 'Baker', 'Lee', 'Allen', 'Morris', 'Khan', 'Scott', 'Watson', 'Davis', 'Parker', 'James', 'Bennett', 'Young', 'Phillips', 'Richardson', 'Mitchell', 'Bailey', 'Carter', 'Cook', 'Singh', 'Shaw', 'Bell', 'Collins', 'Morgan', 'Kelly', 'Begum', 'Hussain', 'Ali', 'Ahmed', 'Nowak', 'Kowalczyk', 'Popescu', 'Mensah', 'Okoro', 'Adeyemi', 'Chen', 'Murray', 'Graham', "O'Neill", 'Fletcher', 'Gibson', 'Matthews'];
// Spellings another system might hold for the same person.
const VARIANTS = { Thompson: 'Thomson', Phillips: 'Philips', "O'Neill": 'ONeill', Mohammed: 'Mohammad', Steven: 'Stephen', Davies: 'Davis', Clarke: 'Clark', Mitchell: 'Mitchel', Matthews: 'Mathews', Hussain: 'Hussein', Begum: 'Begam', Graham: 'Graeme', Agnieszka: 'Agnieska', Kowalczyk: 'Kowalczik', Popescu: 'Popesku', Jessica: 'Jesica', Michelle: 'Michele', Connor: 'Conor', Callum: 'Calum', Zainab: 'Zaynab' };
const STREETS = ['Mill Lane', 'Harbour Road', 'Station Street', 'Church View', 'Queens Avenue', 'Ropewalk', 'Fisher Street', 'Kiln Close', 'Beacon Way', 'Orchard Rise', 'Tannery Row', 'Marsh Lane', 'Willow Court', 'Quayside', 'Foundry Street', 'Lantern Walk', 'Gull Terrace', 'Abbey Mews', 'Chapel Hill', 'Saltings Way'];
const TOWNS = [['Northtown', 'NS1'], ['Northtown', 'NS2'], ['Southmere', 'NS4'], ['Eastbrook', 'NS6'], ['Westcliff', 'NS8'], ['Harbourside', 'NS3']];
const EMPLOYERS = ['Northshire Care Ltd', 'Harbourside Logistics Ltd', 'Eastbrook Garden Centre', 'Northtown Cleaning Services', 'Southmere Leisure Trust', 'Brightwater Retail Ltd', 'Kestrel Couriers', 'Riverside Care Homes', 'Copperfield Engineering', 'Beacon Bakery', 'Quayside Fish Market', 'Gullwing Hotels', 'Saltings Primary School', 'Northshire Council', 'Lantern Cafe Group', 'Westcliff Motors'];
const CASE_TYPES = ['Rent arrears support', 'Change of circumstances', 'Discretionary housing payment', 'Homelessness prevention', 'Tenancy sustainment'];
const WORKERS = ['B. Officer', 'C. Caseworker', 'D. Adviser'];
const TENANCY_TYPES = ['Assured tenancy', 'Assured shorthold tenancy', 'Starter tenancy'];
const ALPHA = 'ABCDEFGHJLNPQRSTUWXYZ';

// ------------------------------------------------------------------ dates and money

const pad = (n, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d) => d.toISOString().slice(0, 10);
const day = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => iso(new Date(day(s).getTime() + n * 86400000));
const uk = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const ukLong = (s) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
const money = (n) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (n) => n.toFixed(2);
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ the people and their cases

function makeNino(rng, used) {
  for (;;) {
    const digits = `${pad(rng.int(0, 99))}${pad(rng.int(0, 99))}${pad(rng.int(0, 99))}`;
    const n = `QQ${digits}${'ABCD'[rng.int(0, 3)]}`;
    if (!used.has(n)) { used.add(n); return n; }
  }
}
const spacedNino = (n) => `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n.slice(8)}`;

function makeAddress(rng) {
  const [town, district] = rng.pick(TOWNS);
  const postcode = `${district} ${rng.int(1, 9)}${rng.pick(ALPHA)}${rng.pick(ALPHA)}`;
  const flat = rng.chance(0.55) ? `Flat ${rng.int(1, 24)}, ` : '';
  return { line: `${flat}${rng.int(1, 140)} ${rng.pick(STREETS)}`, town, postcode };
}
const oneLine = (a) => `${a.line}, ${a.town}, ${a.postcode}`;

function makePerson(rng, used) {
  const female = rng.chance(0.55);
  const firstName = rng.pick(female ? FEMALE : MALE);
  const lastName = rng.pick(SURNAMES);
  const title = female ? rng.pick(['Ms', 'Mrs', 'Miss', 'Ms']) : 'Mr';
  const dob = iso(new Date(Date.UTC(rng.int(1958, 2004), rng.int(0, 11), rng.int(1, 28))));
  let phone;
  do phone = `07700 900${pad(rng.int(0, 999), 3)}`; while (used.phones.has(phone));
  used.phones.add(phone);
  const email = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + `${rng.int(1, 99)}@${rng.pick(['example.org', 'example.com'])}`;
  return { title, firstName, lastName, dob, nino: makeNino(rng, used.ninos), phone, email, address: makeAddress(rng) };
}

/** An employment history ending today, and the weekly income it gives. */
function makeIncome(rng, person) {
  const status = rng.pick(['Employed (full-time)', 'Employed (part-time)', 'Employed (part-time)', 'Not working', 'Self-employed', 'Employed (zero-hours)']);
  const periods = [];
  let at = addDays(TODAY, -rng.int(5 * 365, 9 * 365));
  let employer = null;
  for (let i = 0; i < 4; i++) {
    const len = rng.int(200, 900);
    const end = addDays(at, len);
    if (end >= TODAY) break;
    periods.push({ type: 'Employment', what: rng.pick(EMPLOYERS), from: at, to: end });
    at = addDays(end, rng.int(1, 120));
  }
  const working = status !== 'Not working';
  if (working) {
    employer = status === 'Self-employed' ? 'Self-employed (cleaning)' : rng.pick(EMPLOYERS);
    periods.push({ type: 'Employment', what: employer, from: at, to: '' });
  }
  const ucFrom = rng.chance(working ? 0.6 : 0.95) ? addDays(TODAY, -rng.int(60, 1400)) : null;
  if (ucFrom) periods.push({ type: 'Benefit', what: 'Universal Credit', from: ucFrom, to: '' });
  periods.sort((a, b) => a.from.localeCompare(b.from));
  const weekly = working ? round2(status.includes('full') ? rng.int(42000, 61000) / 100 : rng.int(9000, 34000) / 100) : 0;
  return { status, employer, weekly, ucFrom, periods, person };
}

/** A rent account: monthly rent and a year of payments, some short. Arrears are what the payments leave owing. */
function makeTenancy(rng, ref) {
  const rent = round2(rng.int(42000, 89000) / 100);
  const start = addDays(TODAY, -rng.int(400, 3600));
  const payments = [];
  let owed = 0;
  for (let m = 10; m >= 0; m--) {
    const d = new Date(day(TODAY));
    d.setUTCMonth(d.getUTCMonth() - m, rng.int(1, 6));
    const date = iso(d);
    if (date < start || date > TODAY) continue;
    const full = rng.chance(0.55);
    const amount = full ? rent : round2(rent * rng.int(0, 85) / 100);
    owed = round2(owed + rent - amount);
    if (amount > 0) payments.push({ date, label: rng.chance(0.4) ? 'UC housing element' : 'Tenant payment', amount });
  }
  return { ref, rent, start, type: rng.pick(TENANCY_TYPES), payments, arrears: Math.max(0, owed) };
}

// The six messages a client has: ordinary contact, and at most one "Tell us about a change" form.
const SUBJECTS = {
  'Online form': ['Online form submission'],
  Email: ['Re: your rent account', 'Question about my claim', 'Payslips attached', 'Re: appointment', 'Help with bills'],
  'Phone call': ['Call back request', 'Call logged by contact centre', 'Missed call'],
  Letter: ['Letter received (scanned)', 'Letter from Harbour Homes (scanned)'],
  'Web chat': ['Web chat transcript'],
};
const BODIES = {
  Email: ['I tried to pay my rent but the payment didn’t go through. Can someone call me?', 'Please find attached my last two payslips as asked.', 'Can you tell me where my claim has got to? I haven’t heard anything for two weeks.', 'I can’t make Thursday’s appointment because of work. Is there another time?'],
  'Phone call': ['Client called asking for an update on the case. Advised a caseworker would be in touch within 5 working days.', 'Client asked for a call back about the arrears letter.', 'Missed call from the client’s mobile. No voicemail left.'],
  Letter: ['Scanned letter: a reminder of the rent account balance and an offer of an appointment with the income team.', 'Scanned letter from the client asking for help with the arrears and giving consent to speak to Harbour Homes.'],
  'Web chat': ['Client asked how to apply for help with rent. Sent the link to the online form.', 'Client asked whether they need to tell the council about new working hours. Advised to use the Tell us about a change form.'],
};

function makeMessages(rng, c) {
  const kinds = [];
  const change = c.change; // null | { kind: 'income' | 'moving', … }
  const slots = [...Array(MESSAGES_PER_CLIENT).keys()];
  const changeAt = change ? rng.int(0, MESSAGES_PER_CLIENT - 1) : -1;
  // One or two other online forms, so the type and subject don't give the change away.
  const otherForms = new Set();
  while (otherForms.size < rng.int(1, 2)) { const i = rng.int(0, MESSAGES_PER_CLIENT - 1); if (i !== changeAt) otherForms.add(i); }
  let at = addDays(TODAY, -rng.int(1, 6));
  for (const i of slots) {
    const received = `${at}T${pad(rng.int(8, 17))}:${pad(rng.int(0, 59))}`;
    let type;
    let form = null;
    if (i === changeAt) {
      type = 'Online form';
      // Reported within three weeks of the change; a move is reported before the tenancy ends.
      change.effective = addDays(at, -rng.int(0, 21));
      if (change.kind === 'moving') change.tenancyEnd = addDays(at, rng.int(28, 70));
      form = change.kind === 'income'
        ? { name: 'Tell us about a change', answers: [['What has changed', 'My income'], ['Effective date', change.effective], ['New employer', change.employer || 'Not working'], ['New weekly income', change.weekly], ['Anything else', change.note]] }
        : { name: 'Tell us about a change', answers: [['What has changed', 'I am moving home'], ['Effective date', change.effective], ['Tenancy end date', change.tenancyEnd], ['Reason', change.note]] };
    } else if (otherForms.has(i)) {
      type = 'Online form';
      form = rng.chance(0.5)
        ? { name: 'Contact us', answers: [['Reason for contact', rng.pick(['Rent', 'Council tax', 'Repairs', 'Something else'])], ['Best time to call', rng.pick(['Morning', 'Afternoon', 'Any time'])], ['Message', 'Please call me back about my account.']] }
        : { name: 'Request a call back', answers: [['Topic', rng.pick(['My rent account', 'Housing advice', 'Benefits'])], ['Phone number', c.person.phone], ['Best time to call', rng.pick(['Morning', 'Afternoon'])]] };
    } else {
      type = rng.pick(['Email', 'Email', 'Phone call', 'Letter', 'Web chat']);
    }
    const subject = rng.pick(SUBJECTS[type]);
    const body = form ? `Submitted through the council website by ${c.person.firstName} ${c.person.lastName}.` : rng.pick(BODIES[type]);
    kinds.push({ n: i + 1, id: `MSG-${pad(rng.int(100000, 999999), 6)}`, received, type, channel: { 'Online form': 'Website', Email: 'Email', 'Phone call': 'Telephone', Letter: 'Post', 'Web chat': 'Website' }[type], subject, body, form, status: rng.chance(0.7) ? 'Read' : 'Unread', attachments: [] });
    at = addDays(at, -rng.int(3, 40));
  }
  return kinds;
}

/** The whole fictional world, from the seed: [{ no, ref, type, received, priority, status, person, … }]. */
export function buildData(seed = SEED) {
  const rng = makeRng(seed);
  const used = { ninos: new Set(['QQ123456C', 'QQ987654A']), phones: new Set(['07700 900123', '07700 900456']), clients: new Set([1042, 2077]), tenancies: new Set([20931]) };
  const cases = [];
  let received = '2026-08-17';
  for (let i = 0; i < CASE_COUNT; i++) {
    const no = FIRST_CASE + i;
    received = addDays(received, rng.int(0, 1));
    let clientNo;
    do clientNo = rng.int(3000, 9899); while (used.clients.has(clientNo));
    used.clients.add(clientNo);
    let hh;
    do hh = rng.int(30000, 49999); while (used.tenancies.has(hh));
    used.tenancies.add(hh);
    const person = makePerson(rng, used);
    if (QUIRKS.spelling.includes(no)) {
      // Make sure this person has a name with a known variant.
      const v = Object.keys(VARIANTS).filter((k) => SURNAMES.includes(k));
      person.lastName = v[rng.int(0, v.length - 1)];
    }
    const c = {
      no, ref: `HSG/2026/${no}`, clientId: `NC-${clientNo}`, type: rng.pick(CASE_TYPES), received,
      priority: rng.pick(['High', 'Normal', 'Normal', 'Normal', 'Low']), worker: rng.pick(WORKERS),
      status: i < 70 ? 'New' : rng.pick(['New', 'In progress', 'Awaiting evidence']),
      person, household: rng.int(1, 5),
    };
    c.income = makeIncome(rng, person);
    c.tenancy = makeTenancy(rng, `HH-${hh}`);
    // Harbour Homes' view of the tenant.
    c.harbour = { firstName: person.firstName, lastName: person.lastName, phone: rng.chance(0.2) ? (() => { let p; do p = `07700 900${pad(rng.int(0, 999), 3)}`; while (used.phones.has(p)); used.phones.add(p); return p; })() : person.phone, address: person.address };
    if (QUIRKS.address.includes(no)) c.harbour.address = makeAddress(rng);
    // The income system's view: the same person, or a spelling of them, or someone else under the reference.
    c.biv = { firstName: person.firstName, lastName: person.lastName, dob: person.dob, nino: person.nino };
    if (QUIRKS.spelling.includes(no)) c.biv.lastName = VARIANTS[person.lastName];
    if (QUIRKS.otherPerson.includes(no)) {
      const other = makePerson(rng, used);
      c.biv = { firstName: other.firstName, lastName: person.lastName, dob: other.dob, nino: other.nino };
    }
    // A change the client reported online, which the income system doesn't show yet.
    const roll = rng.next();
    if (roll < 0.55) {
      const working = rng.chance(0.85);
      c.change = {
        kind: 'income', employer: working ? rng.pick(EMPLOYERS) : null,
        weekly: working ? round2(rng.int(8000, 52000) / 100) : 0, note: working ? rng.pick(['My hours have changed.', 'I started a new job.', 'My contract changed to fewer hours.']) : 'I lost my job.',
      };
    } else if (roll < 0.7) {
      c.change = { kind: 'moving', note: rng.pick(['Moving in with family.', 'The flat is too small for us.', 'Moving nearer to work.']) };
    } else c.change = null;
    c.messages = makeMessages(rng, c);
    c.notes = makeNotes(rng, c);
    cases.push(c);
  }
  return cases;
}

function makeNotes(rng, c) {
  const p = c.person;
  const notes = [{ date: c.received, by: 'Contact centre', text: `Case opened from a ${rng.pick(['phone call', 'web form', 'referral from Harbour Homes', 'letter'])}. ${c.type}.` }];
  notes.push({ date: addDays(c.received, rng.int(1, 4)), by: c.worker, text: `Triage: ${p.firstName} lives with ${c.household === 1 ? 'no one else' : `${c.household - 1} other ${c.household === 2 ? 'person' : 'people'}`}. Rent is paid to Harbour Homes, tenancy ${c.tenancy.ref}.` });
  if (c.tenancy.arrears > 0) notes.push({ date: addDays(c.received, rng.int(5, 9)), by: c.worker, text: `Harbour Homes confirmed arrears of ${money(c.tenancy.arrears)}. No court action yet.` });
  if (QUIRKS.otherPerson.includes(c.no)) notes.push({ date: addDays(c.received, 10), by: 'B. Officer', text: 'The income record linked to this client looked wrong at triage. Check the date of birth before using it.' });
  return notes.sort((a, b) => b.date.localeCompare(a.date));
}

// ------------------------------------------------------------------ referrals from other organisations

// A referral asks the housing team to act for one of an organisation's clients. Each organisation is fictional.
const ORGS = {
  harbour: { name: 'Harbour Homes tenancy team', reasons: ['Notice seeking possession served', 'Rent arrears, tenancy at risk'] },
  hospital: { name: 'Northtown General Hospital discharge team', reasons: ['Ready for discharge, no safe home to return to', 'Home no longer suitable after a stay in hospital'] },
  probation: { name: 'Northshire Probation Service', reasons: ['Release date set, no address', 'Approved premises place ending'] },
  children: { name: 'Southmere Children’s Centre', reasons: ['Family at risk of eviction', 'Family living in one room'] },
  care: { name: 'Northshire Adult Social Care', reasons: ['Care needs mean the home is no longer suitable', 'At risk of losing their home'] },
};
const REFERRAL_SUBJECT = 'Referral received';

/**
 * Where the referrals go, planned as QUIRKS are so the demo and the tests can point at them. Inbox page 1 has 4
 * urgent open referrals (two for named cases), 2 urgent ones already accepted or closed, 2 routine open ones and
 * 4 enquiries: 12 of its 25 rows, all received on 24 or 25 Nov so they are newer than every existing message
 * but the newest 10. The rest are spread over the four weeks before.
 */
export const REFERRALS = {
  count: 40,
  clients: 32,
  enquiries: 20,
  // Urgent open referrals on inbox page 1 for these cases, from these organisations; the triage demo names them.
  urgentOnPage1: [{ case: 1012, org: 'harbour', reason: 'Notice seeking possession served' }, { case: 1020, org: 'children', reason: 'Family at risk of eviction' }],
  page1: { urgentOpen: 4, urgentDone: 2, routineOpen: 2, enquiries: 4 },
  rest: { urgentOpen: 8, urgentDone: 4, routineOpen: 8, routineDone: 12 },
};

/** Add n working days (Monday to Friday) to an ISO date. */
function addWorkingDays(s, n) {
  let at = s;
  while (n > 0) { at = addDays(at, 1); const d = day(at).getUTCDay(); if (d !== 0 && d !== 6) n--; }
  return at;
}

/**
 * Referrals and enquiries from partner organisations, from their own seeded stream (seed + 1), so the stream
 * that makes the cases doesn't change. Each is a message: { id, kind: 'referral' | 'enquiry', clientId, client,
 * received, org, subject, type, channel, body, status, attachments, referral? }. An enquiry asks about an earlier
 * referral and has no referral section; in the inbox it looks the same as a referral.
 */
export function buildReferrals(cases, seed = SEED + 1) {
  const rng = makeRng(seed);
  const usedIds = new Set(cases.flatMap((c) => c.messages.map((m) => m.id)));
  const usedPhones = new Set(cases.flatMap((c) => [c.person.phone, c.harbour.phone]));
  const newId = () => { for (;;) { const id = `MSG-${pad(rng.int(100000, 999999), 6)}`; if (!usedIds.has(id)) { usedIds.add(id); return id; } } };
  const newPhone = () => { for (;;) { const p = `07700 900${pad(rng.int(0, 999), 3)}`; if (!usedPhones.has(p)) { usedPhones.add(p); return p; } } };
  const contact = () => {
    const first = rng.pick(rng.chance(0.5) ? FEMALE : MALE);
    const last = rng.pick(SURNAMES);
    return { name: `${first} ${last}`, phone: newPhone(), email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.org' };
  };
  const time = () => `${pad(rng.int(8, 17))}:${pad(rng.int(0, 59))}`;
  const orgKeys = Object.keys(ORGS);

  // The clients: the named cases first, then others drawn without repeats.
  const named = REFERRALS.urgentOnPage1.map((u) => cases.find((c) => c.no === u.case));
  const clients = [...named];
  while (clients.length < REFERRALS.clients) { const c = rng.pick(cases); if (!clients.includes(c)) clients.push(c); }
  const clientFor = (i) => (i < clients.length ? clients[i] : rng.pick(clients));

  // The slots, in order: page 1's, then the rest.
  const P = REFERRALS.page1;
  const R = REFERRALS.rest;
  const slots = [
    ...Array(P.urgentOpen).fill(['Urgent', 'Open', 1]), ...Array(P.urgentDone).fill(['Urgent', 'done', 1]), ...Array(P.routineOpen).fill(['Routine', 'Open', 1]),
    ...Array(R.urgentOpen).fill(['Urgent', 'Open', 0]), ...Array(R.urgentDone).fill(['Urgent', 'done', 0]),
    ...Array(R.routineOpen).fill(['Routine', 'Open', 0]), ...Array(R.routineDone).fill(['Routine', 'done', 0]),
  ];
  // Page 1's received times: 24 Nov afternoon or 25 Nov morning, newest first after sorting.
  const page1Time = () => (rng.chance(0.5) ? `2026-11-24T${pad(rng.int(12, 17))}:${pad(rng.int(0, 59))}` : `2026-11-25T${pad(rng.int(8, 11))}:${pad(rng.int(0, 59))}`);
  const out = [];
  slots.forEach(([urgency, st, onPage1], i) => {
    const c = clientFor(i);
    const plan = REFERRALS.urgentOnPage1[i];
    const orgKey = plan?.org ?? rng.pick(orgKeys);
    const org = ORGS[orgKey];
    const reason = plan?.reason ?? rng.pick(org.reasons);
    const received = onPage1 ? page1Time() : `${addDays(TODAY, -rng.int(3, 36))}T${time()}`;
    const status = st === 'Open' ? 'Open' : rng.pick(['Accepted', 'Closed']);
    const who = contact();
    out.push({
      id: newId(), kind: 'referral', clientId: c.clientId, client: c, received, org: org.name, subject: REFERRAL_SUBJECT, type: 'Email', channel: 'Email',
      body: `We are referring ${fullName(c.person)} to the Housing Support Team: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}. The details are below. Please call or email me if you need anything else.`,
      status: rng.chance(0.5) ? 'Read' : 'Unread', attachments: [],
      referral: { org: org.name, reason, urgency, status, respondBy: addWorkingDays(received.slice(0, 10), urgency === 'Urgent' ? 2 : 10), contact: who },
    });
  });
  // Enquiries: the same organisation asking about one of the older referrals, a few days after it.
  const older = out.filter((r) => r.received.slice(0, 10) < '2026-11-24');
  for (let i = 0; i < REFERRALS.enquiries; i++) {
    const about = rng.pick(older);
    const onPage1 = i < P.enquiries;
    const later = addDays(about.received.slice(0, 10), rng.int(1, 6));
    const received = onPage1 ? page1Time() : `${later < '2026-11-22' ? later : '2026-11-22'}T${time()}`;
    out.push({
      id: newId(), kind: 'enquiry', clientId: about.clientId, client: about.client, received, org: about.org, subject: REFERRAL_SUBJECT, type: 'Email', channel: 'Email',
      body: `We referred ${fullName(about.client.person)} to you on ${ukLong(about.received.slice(0, 10))}. Could you tell us whether someone has picked this up, and who we should speak to?`,
      status: rng.chance(0.5) ? 'Read' : 'Unread', attachments: [], about: about.id,
    });
  }
  return out;
}

// ------------------------------------------------------------------ pages

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
// Each system's nav, as paths from the system's own folder. The first item is its homepage (index.html), and the
// system's name in the header links there too. There's no search page: a search would need a script or a
// server, and the demo has neither on purpose.
const SYSTEMS = {
  cm: { name: 'Northshire Council · Case Manager', cls: 'sys-cm', user: 'A. Worker (Housing Support Team)', nav: [['Home', 'index.html'], ['Work queue', 'queue.html']] },
  biv: { name: 'Benefits and Income Verification', cls: 'sys-biv', user: 'A. Worker · Northshire Council', nav: [['Find a person', 'index.html']] },
  harbour: { name: 'Harbour Homes · Partner portal', cls: 'sys-harbour', user: 'Northshire Council (A. Worker)', nav: [['Tenancies', 'index.html']] },
  messages: { name: 'Northshire Council · Customer Messages', cls: 'sys-messages', user: 'A. Worker (Housing Support Team)', nav: [['Team inbox', 'index.html'], ['Clients', 'clients.html']] },
  // The council's staff intranet, where the team's procedures live. It's written as the council's own, so its
  // footer doesn't name the demo either.
  intranet: { name: 'Northshire Council · Staff intranet', cls: 'sys-intranet', user: 'A. Worker (Housing Support Team)', nav: [['Procedures', 'index.html']], foot: 'A fictional council’s intranet. Every person and record here is made up.' },
};

function page({ file, system, title, body, script = false }) {
  const s = SYSTEMS[system];
  const up = '../'.repeat(file.split('/').length - 1);
  // From the page to its system's folder: '' for cm/queue.html, '../' for messages/client/NC-1234.html.
  const home = '../'.repeat(file.split('/').length - 2);
  const own = file.slice(system.length + 1);
  // A nav item is current on its own page and on that page's later pages (queue-2.html is still the queue).
  const current = (href) => own === href || own.startsWith(`${href.replace(/\.html$/, '')}-`) && /^[a-z]+-\d+\.html$/.test(own);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} – ${esc(s.name)}</title>
<link rel="stylesheet" href="${up}assets/systems.css">
</head>
<body class="${s.cls}">
<header class="topbar"><a class="system" href="${home}index.html">${esc(s.name)} <small>(fictional)</small></a>
<nav aria-label="${esc(s.name.split(' · ').pop())}">${s.nav.map(([label, href]) => `<a href="${home}${href}"${current(href) ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
<span class="user">Logged in as <b>${esc(s.user)}</b></span></header>
<main>
${body}
</main>
<footer class="foot">${esc(s.foot || 'A fictional system for the Power Loader demo. Every person and record here is made up.')}</footer>
${script ? `<script src="${up}assets/casework.js"></script>\n` : ''}</body>
</html>
`;
}

/** Links to every page of a list, 25 a page: name(k) is page k's file, as `queue.html`, `queue-2.html`. */
const pageName = (stem) => (k) => (k === 1 ? `${stem}.html` : `${stem}-${k}.html`);
function paging(n, pages, name, label) {
  if (pages < 2) return '';
  return `<nav class="paging" aria-label="${esc(label)}">${Array.from({ length: pages }, (_, i) => (i + 1 === n ? `<span aria-current="page">${i + 1}</span>` : `<a href="${name(i + 1)}">${i + 1}</a>`)).join(' ')}${n < pages ? ` <a href="${name(n + 1)}" rel="next">Next page</a>` : ''}</nav>`;
}
const pagesOf = (list) => Math.max(1, Math.ceil(list.length / PAGE_SIZE));
const slice = (list, n) => list.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
const byName = (a, b) => a.lastName.localeCompare(b.lastName, 'en-GB') || a.firstName.localeCompare(b.firstName, 'en-GB');

const row = (label, value, attrs = '') => `<tr><th scope="row">${esc(label)}</th><td${attrs}>${esc(value)}</td></tr>`;
const dl = (pairs) => `<dl>\n${pairs.map(([k, v]) => `  <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n')}\n</dl>`;
const statusTag = (s) => `<span class="tag ${s.toLowerCase().replace(/\s+/g, '-')}">${esc(s)}</span>`;
const fullName = (p) => `${p.firstName} ${p.lastName}`;

function queuePage(cases, n, pages) {
  const start = (n - 1) * PAGE_SIZE;
  const list = cases.slice(start, start + PAGE_SIZE);
  const name = pageName('queue');
  const body = `<section class="panel" id="queue" data-first="${FIRST_CASE}" data-count="${cases.length}">
  <h1>Work queue</h1>
  <p>Housing Support Team. ${cases.length} cases, oldest first. Pick up the oldest case that isn’t done.</p>
  <p class="next-case" id="next-case"><a class="button" href="case-${FIRST_CASE}.html">Pick up the next case</a></p>
  <p class="filters"><label for="type-filter">Case type</label> <select id="type-filter"><option value="">All types</option>${CASE_TYPES.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
  <label><input type="checkbox" id="hide-done"> Hide cases marked done</label></p>
  <table id="cases">
    <caption>Cases ${start + 1} to ${start + list.length} of ${cases.length}</caption>
    <thead><tr><th scope="col">Case reference</th><th scope="col">Client</th><th scope="col">Case type</th><th scope="col">Received</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
    <tbody>
${list.map((c) => `      <tr data-case="${c.no}" data-type="${esc(c.type)}"><td><a href="case-${c.no}.html">${c.ref}</a></td><td>${esc(fullName(c.person))}</td><td>${esc(c.type)}</td><td>${uk(c.received)}</td><td>${c.priority}</td><td class="status">${statusTag(c.status)}</td><td><a class="pick-up" href="case-${c.no}.html">Pick up</a></td></tr>`).join('\n')}
    </tbody>
  </table>
  ${paging(n, pages, name, 'Pages of the work queue')}
  <p class="reset"><a href="queue.html?reset" id="reset-demo">Reset the demo</a> (clears the cases marked done, in this browser only)</p>
</section>`;
  return page({ file: `cm/${name(n)}`, system: 'cm', title: n === 1 ? 'Work queue' : `Work queue, page ${n}`, body, script: true });
}

function casePage(c) {
  const p = c.person;
  const body = `<p class="breadcrumbs"><a href="queue.html">Work queue</a> › ${c.ref}</p>
<section class="panel" id="case-header" data-case="${c.no}" data-first="${FIRST_CASE}" data-count="${CASE_COUNT}">
  <h1>Case ${c.ref}</h1>
  <p>${esc(c.type)} · Received ${uk(c.received)} · Status <span class="status">${statusTag(c.status)}</span></p>
  <p class="case-actions"><button type="button" id="mark-done">Mark as done</button> <span id="done-message" role="status"></span></p>
</section>
<section class="panel" id="case-summary">
  <h2>Case summary</h2>
  ${dl([['Case reference', c.ref], ['Case number', String(c.no)], ['Case type', c.type], ['Received', uk(c.received)], ['Priority', c.priority], ['Allocated worker', c.worker]])}
</section>
<section class="panel" id="client">
  <h2>Client</h2>
  <table class="details">
    ${row('Client ID', c.clientId)}
    ${row('Title', p.title)}
    ${row('First name', p.firstName)}
    ${row('Last name', p.lastName)}
    ${row('Date of birth', uk(p.dob))}
    ${row('NI number', spacedNino(p.nino))}
    ${row('Telephone', p.phone)}
    ${row('Email', p.email)}
    ${row('Address', oneLine(p.address))}
    ${row('People in household', String(c.household))}
    ${row('Landlord', 'Harbour Homes Ltd')}
    ${QUIRKS.noTenancyRef.includes(c.no) ? '' : row('Landlord reference', c.tenancy.ref)}
  </table>
</section>
<section class="panel" id="records">
  <h2>Records in other systems</h2>
  <ul>
    <li><a href="notes-${c.no}.html">Case notes</a> (${c.notes.length})</li>
    <li><a href="../messages/client/${c.clientId}.html">Customer messages for ${esc(fullName(p))}</a> (${c.messages.length})</li>
    <li><a href="../biv/income-${c.clientId}.html">Employment and income</a> (Benefits and Income Verification)</li>
    ${QUIRKS.noTenancyRef.includes(c.no) ? '<li>Rent account: no Harbour Homes tenancy reference on the case yet</li>' : `<li><a href="../harbour/tenancy-${c.tenancy.ref}.html">Rent account ${c.tenancy.ref}</a> (Harbour Homes)</li>`}
  </ul>
</section>
<section class="panel" id="forms">
  <h2>Forms</h2>
  <p><a href="../rent-review.html?case=${c.no}">Start a rent support review</a> (<a href="../intranet/rent-support-review.html">how to do a rent support review</a>)</p>
</section>`;
  return page({ file: `cm/case-${c.no}.html`, system: 'cm', title: `Case ${c.ref}`, body, script: true });
}

function notesPage(c) {
  const body = `<p class="breadcrumbs"><a href="queue.html">Work queue</a> › <a href="case-${c.no}.html">${c.ref}</a> › Case notes</p>
<section class="panel" id="notes">
  <h1>Case notes for ${c.ref}</h1>
  <p>Client ${esc(fullName(c.person))} (${c.clientId})</p>
${c.notes.map((n) => `  <div class="note"><small><span class="date">${uk(n.date)}</span> · <span class="by">${esc(n.by)}</span></small><p>${esc(n.text)}</p></div>`).join('\n')}
</section>`;
  return page({ file: `cm/notes-${c.no}.html`, system: 'cm', title: `Case notes ${c.ref}`, body });
}

function incomePage(c) {
  const b = c.biv;
  const inc = c.income;
  const body = `<section class="panel" id="person">
  <h1>Employment and income</h1>
  ${dl([['First names', b.firstName], ['Surname', b.lastName], ['NI number', b.nino], ['Date of birth', ukLong(b.dob)], ['Council reference', c.clientId],
    ['Employment status', inc.status], ['Current employer', inc.employer || 'None'], ['Weekly income', money(inc.weekly)], ['Universal Credit', inc.ucFrom ? `Yes, since ${ukLong(inc.ucFrom)}` : 'No'], ['Last updated', uk(lastUpdated(c))]])}
</section>
<section class="panel">
  <h2>History</h2>
  <table id="history">
    <thead><tr><th scope="col">Type</th><th scope="col">Employer or benefit</th><th scope="col">From</th><th scope="col">To</th></tr></thead>
    <tbody>
${inc.periods.map((x) => `      <tr><td>${x.type}</td><td>${esc(x.what)}</td><td>${uk(x.from)}</td><td>${x.to ? uk(x.to) : ''}</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>`;
  return page({ file: `biv/income-${c.clientId}.html`, system: 'biv', title: `Employment and income ${c.clientId}`, body });
}

function tenancyPage(c) {
  const t = c.tenancy;
  const h = c.harbour;
  const body = `<section class="panel" id="tenancy">
  <h1>Tenancy ${t.ref}</h1>
  <dl>
    <dt>Tenancy reference</dt><dd>${t.ref}</dd>
    <dt>Tenant</dt><dd class="tenant">${esc(`${h.firstName} ${h.lastName}`)}</dd>
    <dt>Contact number</dt><dd>${h.phone}</dd>
    <dt>Property</dt><dd>${esc(oneLine(h.address))}</dd>
    <dt>Landlord</dt><dd>Harbour Homes Ltd</dd>
    <dt>Tenancy start</dt><dd>${uk(t.start)}</dd>
    <dt>Tenancy type</dt><dd>${t.type}</dd>
    <dt>Monthly rent</dt><dd>${money(t.rent)}</dd>
  </dl>
  <div class="accordion" id="balance">
    <h2 class="accordion__head"><button type="button" class="accordion__button" data-accordion aria-expanded="false" aria-controls="balance-body">Rent account balance</button></h2>
    <div class="accordion__body" id="balance-body">
      <dl>
        <dt>Arrears</dt><dd class="bal">${money(t.arrears)}</dd>
      </dl>
    </div>
  </div>
</section>
<section class="panel">
  <h2>Payments received</h2>
  <table id="payments">
    <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="num">Amount</th></tr></thead>
    <tbody>
${t.payments.map((x) => `      <tr><td>${uk(x.date)}</td><td>${x.label}</td><td class="num">${plain(x.amount)}</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>`;
  return page({ file: `harbour/tenancy-${t.ref}.html`, system: 'harbour', title: `Tenancy ${t.ref}`, body, script: true });
}

const when = (m) => `${uk(m.received.slice(0, 10))} ${m.received.slice(11)}`;
const answerText = (k, v) => (k === 'New weekly income' ? money(v) : /date$/i.test(k) ? uk(v) : v);

function clientMessagesPage(c, others = []) {
  const p = c.person;
  const body = `<p class="breadcrumbs"><a href="../clients.html">Clients</a> › ${c.clientId}</p>
<section class="panel" id="client">
  <h1>${esc(fullName(p))}</h1>
  ${dl([['Client ID', c.clientId], ['Date of birth', uk(p.dob)], ['Address', oneLine(p.address)]])}
</section>
<section class="panel">
  <h2>Messages</h2>
  <p>The latest ${c.messages.length} messages from this client, newest first. Open a message to read it and any form answers. <a href="../api/${c.clientId}.json">These messages as data (JSON)</a></p>
  <table id="messages">
    <thead><tr><th scope="col">Received</th><th scope="col">Subject</th><th scope="col">Type</th><th scope="col">Channel</th><th scope="col">Status</th></tr></thead>
    <tbody>
${c.messages.map((m) => `      <tr><td>${when(m)}</td><td><a href="../message/${c.clientId}-${m.n}.html">${esc(m.subject)}</a></td><td>${m.type}</td><td>${m.channel}</td><td>${m.status}</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>${others.length ? `
<section class="panel">
  <h2>From other organisations</h2>
  <p>Messages about this client from partner organisations, newest first.</p>
  <table id="other-messages">
    <thead><tr><th scope="col">Received</th><th scope="col">Subject</th><th scope="col">Type</th><th scope="col">Channel</th><th scope="col">Status</th></tr></thead>
    <tbody>
${others.map((m) => `      <tr><td>${when(m)}</td><td><a href="../message/${m.id}.html">${esc(m.subject)}</a></td><td>${m.type}</td><td>${m.channel}</td><td>${m.status}</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>` : ''}`;
  return page({ file: `messages/client/${c.clientId}.html`, system: 'messages', title: `Messages for ${fullName(p)}`, body });
}

function messagePage(c, m) {
  const body = `<p class="breadcrumbs"><a href="../client/${c.clientId}.html">${esc(fullName(c.person))}</a> › Message ${m.n} of ${c.messages.length}</p>
<section class="panel" id="message">
  <h1>${esc(m.subject)}</h1>
  ${dl([['Message ID', m.id], ['Client ID', c.clientId], ['From', fullName(c.person)], ['Received', when(m)], ['Type', m.type], ['Channel', m.channel]])}
</section>
<section class="panel" id="body">
  <h2>Message</h2>
  <p>${esc(m.body)}</p>
</section>
${m.form ? `<section class="panel" id="form">
  <h2>Form answers: ${esc(m.form.name)}</h2>
  ${dl(m.form.answers.map(([k, v]) => [k, answerText(k, v)]))}
</section>
` : ''}${attachmentsSection(m)}<p class="paging">${m.n > 1 ? `<a href="${c.clientId}-${m.n - 1}.html">Newer message</a> ` : ''}${m.n < c.messages.length ? `<a href="${c.clientId}-${m.n + 1}.html">Older message</a>` : ''}</p>`;
  return page({ file: `messages/message/${c.clientId}-${m.n}.html`, system: 'messages', title: m.subject, body });
}

// ------------------------------------------------------------------ homepages and lists

const STATUSES = ['New', 'In progress', 'Awaiting evidence'];
const lastUpdated = (c) => addDays(TODAY, -40 - (c.no % 50));

/** Case Manager's home: my work, worked out at build time; the next case and the oldest come from casework.js. */
function cmHomePage(cases) {
  const count = (pred) => cases.filter(pred).length;
  const oldest = cases.slice(0, 10);
  const body = `<section class="panel" id="home" data-first="${FIRST_CASE}" data-count="${cases.length}">
  <h1>My work</h1>
  <p>Housing Support Team. ${cases.length} cases in the work queue.</p>
  <p class="next-case" id="next-case"><a class="button" href="case-${FIRST_CASE}.html">Pick up the next case</a></p>
  <table id="by-status">
    <caption>Cases by status</caption>
    <thead><tr><th scope="col">Status</th><th scope="col" class="num">Cases</th></tr></thead>
    <tbody>
${STATUSES.map((st) => `      <tr><td>${statusTag(st)}</td><td class="num">${count((c) => c.status === st)}</td></tr>`).join('\n')}
    </tbody>
  </table>
  <table id="by-type">
    <caption>Cases by type</caption>
    <thead><tr><th scope="col">Case type</th><th scope="col" class="num">Cases</th></tr></thead>
    <tbody>
${CASE_TYPES.map((t) => `      <tr><td>${esc(t)}</td><td class="num">${count((c) => c.type === t)}</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>
<section class="panel" id="oldest">
  <h2>Oldest cases not done</h2>
  <table id="oldest-cases">
    <thead><tr><th scope="col">Case reference</th><th scope="col">Client</th><th scope="col">Case type</th><th scope="col">Received</th></tr></thead>
    <tbody>
${oldest.map((c, i) => `      <tr data-case="${c.no}"${i >= 5 ? ' hidden' : ''}><td><a href="case-${c.no}.html">${c.ref}</a></td><td>${esc(fullName(c.person))}</td><td>${esc(c.type)}</td><td>${uk(c.received)}</td></tr>`).join('\n')}
    </tbody>
  </table>
  <p><a href="queue.html">Go to the work queue</a> · <a href="../messages/index.html">Go to the team inbox</a> · <a href="../intranet/index.html">Procedures</a></p>
</section>`;
  return page({ file: 'cm/index.html', system: 'cm', title: 'My work', body, script: true });
}

/** Benefits and Income Verification's home: every income record, by surname, 25 a page. */
function bivListPage(cases, n) {
  const all = [...cases].sort((a, b) => byName(a.biv, b.biv) || a.no - b.no);
  const list = slice(all, n);
  const name = pageName('index');
  const body = `<section class="panel" id="people">
  <h1>Find a person</h1>
  <p>Every income record, sorted by surname. Open a record to see the person’s employment and income.</p>
  <table id="records">
    <caption>Records ${(n - 1) * PAGE_SIZE + 1} to ${(n - 1) * PAGE_SIZE + list.length} of ${all.length}</caption>
    <thead><tr><th scope="col">Council reference</th><th scope="col">Name</th><th scope="col">Date of birth</th><th scope="col">NI number</th><th scope="col">Last updated</th></tr></thead>
    <tbody>
${list.map((c) => `      <tr><td><a href="income-${c.clientId}.html">${c.clientId}</a></td><td>${esc(`${c.biv.lastName}, ${c.biv.firstName}`)}</td><td>${ukLong(c.biv.dob)}</td><td>${c.biv.nino}</td><td>${uk(lastUpdated(c))}</td></tr>`).join('\n')}
    </tbody>
  </table>
  ${paging(n, pagesOf(all), name, 'Pages of income records')}
</section>`;
  return page({ file: `biv/${name(n)}`, system: 'biv', title: n === 1 ? 'Find a person' : `Find a person, page ${n}`, body });
}

/** Harbour Homes' home: every tenancy, 25 a page, and how many are in arrears. */
function harbourListPage(cases, n) {
  const all = [...cases].sort((a, b) => a.tenancy.ref.localeCompare(b.tenancy.ref));
  const list = slice(all, n);
  const name = pageName('index');
  const body = `<section class="panel" id="tenancies">
  <h1>Tenancies</h1>
  <p>Tenancies shared with Northshire Council: ${all.length}, of which ${all.filter((c) => c.tenancy.arrears > 0).length} are in arrears.</p>
  <table id="tenancy-list">
    <caption>Tenancies ${(n - 1) * PAGE_SIZE + 1} to ${(n - 1) * PAGE_SIZE + list.length} of ${all.length}</caption>
    <thead><tr><th scope="col">Tenancy reference</th><th scope="col">Tenant</th><th scope="col">Property</th><th scope="col" class="num">Monthly rent</th><th scope="col" class="num">Arrears</th></tr></thead>
    <tbody>
${list.map((c) => `      <tr><td><a href="tenancy-${c.tenancy.ref}.html">${c.tenancy.ref}</a></td><td>${esc(`${c.harbour.firstName} ${c.harbour.lastName}`)}</td><td>${esc(oneLine(c.harbour.address))}</td><td class="num">${money(c.tenancy.rent)}</td><td class="num">${money(c.tenancy.arrears)}</td></tr>`).join('\n')}
    </tbody>
  </table>
  ${paging(n, pagesOf(all), name, 'Pages of tenancies')}
</section>`;
  return page({ file: `harbour/${name(n)}`, system: 'harbour', title: n === 1 ? 'Tenancies' : `Tenancies, page ${n}`, body });
}

/** Customer Messages' list of clients, with how many messages each has, 25 a page. */
function clientListPage(cases, n, countOf) {
  const all = [...cases].sort((a, b) => byName(a.person, b.person) || a.no - b.no);
  const list = slice(all, n);
  const name = pageName('clients');
  const body = `<section class="panel" id="clients">
  <h1>Clients</h1>
  <p>Every client with messages, sorted by surname.</p>
  <table id="client-list">
    <caption>Clients ${(n - 1) * PAGE_SIZE + 1} to ${(n - 1) * PAGE_SIZE + list.length} of ${all.length}</caption>
    <thead><tr><th scope="col">Client ID</th><th scope="col">Name</th><th scope="col">Date of birth</th><th scope="col" class="num">Messages</th></tr></thead>
    <tbody>
${list.map((c) => `      <tr><td><a href="client/${c.clientId}.html">${c.clientId}</a></td><td>${esc(`${c.person.lastName}, ${c.person.firstName}`)}</td><td>${uk(c.person.dob)}</td><td class="num">${countOf(c)}</td></tr>`).join('\n')}
    </tbody>
  </table>
  ${paging(n, pagesOf(all), name, 'Pages of clients')}
</section>`;
  return page({ file: `messages/${name(n)}`, system: 'messages', title: n === 1 ? 'Clients' : `Clients, page ${n}`, body });
}

/** How far back the team inbox goes, from the demo's fixed today. */
export const INBOX_DAYS = 28;

/**
 * The team inbox's rows, newest first: every message received in the last INBOX_DAYS days. Each row is
 * { id, received, from, clientId, subject, type, read, href } with href relative to messages/.
 */
export function inboxRows(cases, referrals = buildReferrals(cases)) {
  const since = addDays(TODAY, -INBOX_DAYS);
  const rows = [];
  for (const r of referrals) {
    if (r.received.slice(0, 10) < since) continue;
    rows.push({ id: r.id, received: r.received, from: r.org, clientId: r.clientId, subject: r.subject, type: r.type, read: r.status === 'Read', href: `message/${r.id}.html` });
  }
  for (const c of cases) {
    for (const m of c.messages) {
      if (m.received.slice(0, 10) < since) continue;
      rows.push({ id: m.id, received: m.received, from: fullName(c.person), clientId: c.clientId, subject: m.subject, type: m.type, read: m.status === 'Read', href: `message/${c.clientId}-${m.n}.html` });
    }
  }
  return rows.sort((a, b) => b.received.localeCompare(a.received) || a.id.localeCompare(b.id));
}

/** The Housing Support Team's shared inbox, 25 a page. Nothing in a row says what a message is. */
function inboxPage(rows, n) {
  const list = slice(rows, n);
  const name = pageName('index');
  const body = `<section class="panel" id="team-inbox">
  <h1>Team inbox</h1>
  <p>Housing Support Team. Everything received in the last ${INBOX_DAYS} days, newest first. Open a message to see what it is and whether anyone has picked it up.</p>
  <table id="inbox">
    <caption>Messages ${(n - 1) * PAGE_SIZE + 1} to ${(n - 1) * PAGE_SIZE + list.length} of ${rows.length}</caption>
    <thead><tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">Client</th><th scope="col">Subject</th><th scope="col">Type</th><th scope="col">Read</th></tr></thead>
    <tbody>
${list.map((r) => `      <tr data-message="${r.id}"><td>${when(r)}</td><td>${esc(r.from)}</td><td>${r.clientId}</td><td><a href="${r.href}">${esc(r.subject)}</a></td><td>${r.type}</td><td>${r.read ? 'Yes' : 'No'}</td></tr>`).join('\n')}
    </tbody>
  </table>
  ${paging(n, pagesOf(rows), name, 'Pages of the team inbox')}
</section>`;
  return page({ file: `messages/${name(n)}`, system: 'messages', title: n === 1 ? 'Team inbox' : `Team inbox, page ${n}`, body });
}

/** A message from another organisation: a referral (with its #referral section) or an enquiry (without). */
function orgMessagePage(r) {
  const p = r.client.person;
  const f = r.referral;
  const body = `<p class="breadcrumbs"><a href="../index.html">Team inbox</a> › <a href="../client/${r.clientId}.html">${esc(fullName(p))}</a> › Message from ${esc(r.org)}</p>
<section class="panel" id="message">
  <h1>${esc(r.subject)}</h1>
  ${dl([['Message ID', r.id], ['Client ID', r.clientId], ['From', r.org], ['Received', when(r)], ['Type', r.type], ['Channel', r.channel]])}
</section>
<section class="panel" id="body">
  <h2>Message</h2>
  <p>${esc(r.body)}</p>
</section>
${f ? `<section class="panel" id="referral">
  <h2>Referral</h2>
  ${dl([['Referred by', f.org], ['Reason', f.reason], ['Urgency', f.urgency], ['Referral status', f.status], ['Respond by', uk(f.respondBy)], ['Referrer', f.contact.name], ['Referrer phone', f.contact.phone], ['Referrer email', f.contact.email], ['Client ID', r.clientId], ['Client name', fullName(p)], ['Date of birth', uk(p.dob)]])}
</section>
` : ''}${attachmentsSection(r)}`;
  return page({ file: `messages/message/${r.id}.html`, system: 'messages', title: r.subject, body });
}

// Ready for attachments: every message has a list, and the section is drawn only when there are some.
const attachmentsSection = (m) => (m.attachments?.length ? `<section class="panel" id="attachments">
  <h2>Attachments</h2>
  <ul>
${m.attachments.map((a) => `    <li><a href="${esc(a.href)}">${esc(a.name)}</a></li>`).join('\n')}
  </ul>
</section>
` : '');

// ------------------------------------------------------------------ the staff intranet: the team's own procedure

/** The email a caseworker sends a client who hasn't given their tenancy reference. The demo flow sends the same. */
export const ASK_FOR_REFERENCE = {
  subject: 'Your rent support review: case {ref}',
  body: 'Dear {firstName} {lastName},\n\nWe are reviewing the help you get with your rent (case {ref}). To finish the review we need your Harbour Homes tenancy reference. You can find it on your tenancy agreement or on any letter from Harbour Homes, and it starts with HH-.\n\nPlease reply to this email with the reference, quoting case {ref}.\n\nThank you,\nHousing Support Team\nNorthshire Council',
};

/**
 * The cases the procedure names as training examples, one per branch, taken from the data so each one really
 * has what it's named for. Exported for the test, which checks every number again from the cases.
 */
export function trainingExamples(cases) {
  const quirky = new Set(Object.values(QUIRKS).flat());
  const plain = cases.filter((c) => !quirky.has(c.no));
  return {
    address: QUIRKS.address[0],
    spelling: QUIRKS.spelling[0],
    otherPerson: QUIRKS.otherPerson[0],
    income: plain.find((c) => c.change?.kind === 'income' && c.tenancy.arrears > 0).no,
    moving: plain.find((c) => c.change?.kind === 'moving').no,
    noChange: plain.find((c) => !c.change).no,
    // Every client in the data owes something, so the no-arrears branch has no example; this is the least owed.
    lowestArrears: [...plain].sort((a, b) => a.tenancy.arrears - b.tenancy.arrears)[0].no,
    urgent: REFERRALS.urgentOnPage1[0].case,
  };
}

const caseLink = (no, text = `case ${no}`) => `<a href="../cm/case-${no}.html">${text}</a>`;
const step = (n, title, inner) => `<section class="panel step" id="step-${n}" aria-labelledby="step-${n}-title">
  <h2 id="step-${n}-title"><span class="step-no">Step ${n}.</span> ${title}</h2>
${inner}
</section>`;
const go = (n, text) => `<a href="#step-${n}">${text ?? `go to step ${n}`}</a>`;
const why = (text) => `<details class="why"><summary>Why we do this</summary><p>${text}</p></details>`;
const example = (summary, inner) => `<details class="example"><summary>${summary}</summary>${inner}</details>`;
const emailText = (e) => esc(e).replace(/\n/g, '<br>');

/** The intranet's list of procedures. */
function intranetHome() {
  const body = `<section class="panel" id="procedures">
  <h1>Procedures</h1>
  <p>Housing Support Team procedures. Follow the current version: if a printed copy differs from this page, this page is right.</p>
  <table>
    <thead><tr><th scope="col">Procedure</th><th scope="col">For</th><th scope="col">Last reviewed</th></tr></thead>
    <tbody>
      <tr><td><a href="rent-support-review.html">Rent support review</a></td><td>Caseworkers in the Housing Support Team</td><td>${uk('2026-11-02')}</td></tr>
    </tbody>
  </table>
  <p>Other procedures (discretionary housing payments, homelessness prevention) are kept by the team leader and aren’t on this site yet.</p>
</section>`;
  return page({ file: 'intranet/index.html', system: 'intranet', title: 'Procedures', body });
}

/** The rent support review, as the team's own procedure: numbered steps, decisions, examples, a checklist. */
function intranetReview(cases) {
  const T = trainingExamples(cases);
  const income = cases.find((c) => c.no === T.income);
  const moving = cases.find((c) => c.no === T.moving);
  const emailIncome = 'income.team@example.org';
  const body = `<p class="breadcrumbs"><a href="index.html">Procedures</a> › Rent support review</p>
<section class="panel" id="top">
  <h1>Housing Support Team procedures: Rent support review</h1>
  <p class="meta">Owner: Housing Support Team leader · Last reviewed ${uk('2026-11-02')} · Next review May 2027</p>
  <h2>Purpose</h2>
  <p>A rent support review decides whether a tenant of Harbour Homes needs help with their rent, and how much. It brings together what four systems hold about the client, so the decision rests on the current facts: their tenancy and arrears, their income, and any change they have told us about.</p>
  <h2>Who this applies to</h2>
  <p>Every caseworker in the Housing Support Team who picks up a case from the work queue. Team leaders use it to check reviews before they are paid.</p>
  <h2>What you need before you start</h2>
  <ul>
    <li>Access to <a href="../cm/index.html">Case Manager</a>, <a href="../harbour/index.html">the Harbour Homes partner portal</a>, <a href="../biv/index.html">Benefits and Income Verification</a> and <a href="../messages/index.html">Customer Messages</a>.</li>
    <li>About 20 minutes for a case without complications.</li>
    <li>Somewhere to note values as you go: a notepad, or a draft case note.</li>
  </ul>
  <p class="timing"><strong>Timing yourself?</strong> Note the time when you start step 1 and again when you finish step 10. Training groups compare times to find where reviews get stuck.</p>
</section>
<section class="panel" id="summary">
  <h2>The decisions at a glance</h2>
  <table id="decisions">
    <thead><tr><th scope="col">At</th><th scope="col">If</th><th scope="col">Then</th></tr></thead>
    <tbody>
      <tr><td>${go(1, 'Step 1')}</td><td>The team inbox has an urgent referral that nobody has picked up</td><td>Deal with it first, then come back to the queue</td></tr>
      <tr><td>${go(2, 'Step 2')}</td><td>The case has no Harbour Homes tenancy reference</td><td>${go(3)} and email the client; otherwise ${go(4)}</td></tr>
      <tr><td>${go(4, 'Step 4')}</td><td>Harbour Homes has a different address from the case</td><td>Check which is current (step 4, <i>A different address</i>), then continue</td></tr>
      <tr><td>${go(5, 'Step 5')}</td><td>The income record’s date of birth or NI number differs from the case</td><td>Stop: ${go(6)}</td></tr>
      <tr><td>${go(5, 'Step 5')}</td><td>Only the spelling of the name differs</td><td>Note it and ${go(7, 'continue to step 7')}</td></tr>
      <tr><td>${go(7, 'Step 7')}</td><td>An online form reports a change of income or a move</td><td>Note the dates and amounts, then ${go(8)}</td></tr>
      <tr><td>${go(8, 'Step 8')}</td><td>The client has no arrears</td><td>Recommend no payment unless a change means they will fall behind</td></tr>
    </tbody>
  </table>
  <p>Everything below is in order. Open the parts marked with a triangle for the detail of each case you might meet, worked examples, and why we do it this way. To print the whole procedure, open every part first.</p>
</section>
${step(1, 'Choose a case', `  <ol>
    <li>Open the <a href="../messages/index.html">team inbox</a> first. Urgent referrals from partner organisations must be answered within 2 working days.</li>
    <li>Then open the <a href="../cm/queue.html">work queue</a>. Pick up the oldest case that isn’t done (the queue offers it first with <b>Pick up the next case</b>), unless your team leader has given you a particular case.</li>
  </ol>
  <p><strong>If</strong> the inbox has a referral that is urgent and still open, deal with it before the queue. <strong>Otherwise</strong> ${go(2, 'continue to step 2')}.</p>
  ${example('Urgent referrals in the team inbox', `<p>Every referral and every question about one arrives with the subject <i>Referral received</i>, so the list doesn’t tell you which are referrals or how urgent they are. Open each message from an organisation. A referral has a <b>Referral</b> section giving its urgency, its status (Open, Accepted or Closed) and the date to respond by. An email asking about an earlier referral has no such section.</p>
  <p>For an urgent open referral: call the referrer on the number given, accept the referral in your own system, and start a review for the client if they have a case in the queue.</p>
  <p><b>Training example:</b> the urgent referral for the client of ${caseLink(T.urgent)}, on the first page of the inbox.</p>`)}
  ${why('Referrals are often about someone losing their home within days. A queue is oldest first, so an urgent referral could wait behind weeks of other work if nobody looked at the inbox.')}`)}
${step(2, 'Open the case', `  <p>Open the case from the queue. On the case page, note from <b>Client</b>: the client ID, the name, the date of birth, the NI number, the address and postcode, the email address, and the <b>Landlord reference</b> (the Harbour Homes tenancy reference, which starts HH-).</p>
  <p><strong>If</strong> there is no landlord reference, ${go(3)}. <strong>Otherwise</strong> ${go(4, 'continue to step 4')}.</p>
  ${why('The case is the council’s record of who the client is. Every other system is checked against it, so it comes first.')}`)}
${step(3, 'Ask the client for their tenancy reference', `  <p>Without the tenancy reference you can’t open the right rent account. Email the client at the address on the case, using these words:</p>
  <div class="template" id="ask-for-reference">
    <p><b>Subject:</b> ${esc(ASK_FOR_REFERENCE.subject.replace('{ref}', '[case number]'))}</p>
    <p>${emailText(ASK_FOR_REFERENCE.body.replaceAll('{ref}', '[case number]').replace('{firstName} {lastName}', '[first name] [last name]'))}</p>
  </div>
  <p>Add a case note saying you have asked, and leave the case until they reply. When they do, add the reference to the case and ${go(4, 'continue from step 4')}.</p>
  ${example('When this happens', `<p>Cases created from a phone call sometimes have no tenancy reference, because the client didn’t have it to hand. In the training set, ${QUIRKS.noTenancyRef.map((n) => caseLink(n)).join(', ')} have none.</p>`)}
  ${why('Guessing the rent account from the name and address risks opening someone else’s. Asking the client takes one email.')}`)}
${step(4, 'Check the rent account in Harbour Homes', `  <p>Open the <b>Rent account</b> link on the case, or find the tenancy in the <a href="../harbour/index.html">Harbour Homes list of tenancies</a>. Note the monthly rent, the arrears, the tenancy start date and the tenancy type, and compare the tenant’s name and address with the case.</p>
  <p><strong>If</strong> the address differs from the case, see <i>A different address</i> below before you go on. <strong>Otherwise</strong> ${go(5, 'continue to step 5')}.</p>
  ${example('A different address', `<p>Harbour Homes sometimes still holds a tenant’s previous address. Check the client’s messages and the case notes for a move. Use the address the client most recently gave us, and say in your recommendation that Harbour Homes holds a different one so they can update it.</p>
  <p><b>Training example:</b> ${caseLink(T.address)}.</p>`)}
  ${example('Arrears or none', `<p>Arrears are what the payments received leave owing. Note the figure exactly as shown. A client with no arrears can still need help if a change of income means they will fall behind: see step 8.</p>
  <p><b>Training examples:</b> every client in the training set owes something. ${caseLink(T.lowestArrears)} owes the least (${money(cases.find((c) => c.no === T.lowestArrears).tenancy.arrears)}), and ${caseLink(T.income)} has arrears and a change of income.</p>`)}
  ${why('The rent and arrears are the heart of the decision, and Harbour Homes is the only system that holds them.')}`)}
${step(5, 'Check the income record in Benefits and Income Verification', `  <p>Open the <b>Employment and income</b> link on the case, or <a href="../biv/index.html">find the person</a> by surname. Before you use anything, compare the name, date of birth and NI number with the case.</p>
  <ul>
    <li><strong>If</strong> the date of birth or the NI number differs, the record is someone else’s: ${go(6)}.</li>
    <li><strong>If</strong> only the spelling of the name differs, see <i>A different spelling</i> below, then ${go(7, 'continue to step 7')}.</li>
    <li><strong>Otherwise</strong> note the employment status, the current employer and the weekly income, and ${go(7, 'continue to step 7')}.</li>
  </ul>
  ${example('A different spelling', `<p>The income system was filled in from other sources and sometimes spells a name differently (Thomson for Thompson, Davis for Davies). If the date of birth and NI number match, it is the same person. Use the record, and mention the spelling in your recommendation so it can be corrected.</p>
  <p><b>Training example:</b> ${caseLink(T.spelling)}.</p>`)}
  ${why('A council reference is sometimes reused. Checking the date of birth and NI number every time is what stops us deciding a case on someone else’s income.')}`)}
${step(6, 'Stop: the income record is someone else’s', `  <p>Don’t use the record, and don’t submit a review. Add a case note saying the income record under the client’s reference belongs to someone else, set the case to <b>Awaiting evidence</b>, and tell your team leader so the reference can be fixed. Then go back to the work queue and ${go(1, 'pick up the next case')}.</p>
  ${example('What it looks like', `<p>The surname may match, but the first name, the date of birth and the NI number don’t. The case notes may already say the record looked wrong at triage.</p>
  <p><b>Training example:</b> ${caseLink(T.otherPerson)}.</p>`)}`)}
${step(7, 'Read every message in Customer Messages', `  <p>Open the client’s messages from the case. The list shows six messages, newest first, but not which of them reports a change. Open <strong>every</strong> message and read any form answers.</p>
  <ul>
    <li><strong>If</strong> a <i>Tell us about a change</i> form says <i>My income</i>, note the effective date and the new weekly income.</li>
    <li><strong>If</strong> it says <i>I am moving home</i>, note the effective date and the tenancy end date.</li>
    <li><strong>If</strong> no message reports a change, note that none was reported.</li>
  </ul>
  <p>Then ${go(8)}.</p>
  ${example('A change of income', `<p>The change is in one online form among several. Other forms (<i>Contact us</i>, <i>Request a call back</i>) look the same in the list.</p>
  <p><b>Training example:</b> ${caseLink(T.income)}: the client reported new weekly income of ${money(income.change.weekly)} from ${ukLong(income.change.effective)}.</p>`)}
  ${example('A move', `<p>A client who is moving gives the date their tenancy ends. Record it on the review, because help with rent stops when the tenancy does.</p>
  <p><b>Training example:</b> ${caseLink(T.moving)}: the tenancy ends on ${ukLong(moving.change.tenancyEnd)}.</p>`)}
  ${example('No change reported', `<p>Leave the change fields on the review empty. Don’t write “none” in them.</p>
  <p><b>Training example:</b> ${caseLink(T.noChange)}.</p>`)}
  ${why('The income system shows what we last verified, not what the client has told us since. A change reported online is often the reason the rent is falling behind.')}`)}
${step(8, 'Fill in the review form', `  <p>Open <b>Start a rent support review</b> from the case’s <b>Forms</b>. Fill in each part from your notes:</p>
  <ul>
    <li><b>Client</b>: from the case (step 2).</li>
    <li><b>Tenancy</b>: the landlord reference, monthly rent and arrears from Harbour Homes (step 4), and the tenancy end date if the client is moving (step 7).</li>
    <li><b>Income</b>: the current employer and weekly income on record (step 5), and any change with its effective date and new weekly income (step 7).</li>
    <li><b>Your recommendation</b>: write it yourself. Say what you recommend and why, and anything another system needs to correct.</li>
  </ul>
  <p><strong>If</strong> the client has no arrears and no change that will put them behind, recommend no payment. <strong>Otherwise</strong> recommend the support the arrears and income show they need. Check every box, then submit, and ${go(9, 'continue to step 9')}.</p>
  ${why('The form is what the income team pays from. A review copied carefully from the systems needs no second look.')}`)}
${step(9, 'Tell the income team', `  <p>Email the income team at ${emailIncome} so they can act on the review:</p>
  <div class="template" id="tell-income-team">
    <p><b>Subject:</b> Rent support review for [client ID]</p>
    <p>Case [case reference]: a rent support review has been submitted for [first name] [last name] ([client ID]), tenancy [tenancy reference]. Arrears are £[arrears].</p>
  </div>
  <p>Then ${go(10)}.</p>`)}
${step(10, 'Mark the case done', `  <p>Back on the case page, press <b>Mark as done</b>. The page offers the next case. Note your finish time if you are timing yourself.</p>`)}
<section class="panel" id="checklist">
  <h2>Checklist: a finished review has</h2>
  <ul class="checklist">
    <li>The client’s ID, name, date of birth, NI number, address and postcode, as on the case</li>
    <li>The landlord reference, monthly rent and arrears, as in Harbour Homes</li>
    <li>The weekly income on record, from an income record whose date of birth and NI number match the case</li>
    <li>Any change the client reported, with its effective date, and the new weekly income or the tenancy end date</li>
    <li>A recommendation in your own words, mentioning any address or spelling another system should correct</li>
    <li>An email to the income team, and the case marked done</li>
  </ul>
  <p>Started at ______ · Finished at ______</p>
</section>`;
  return page({ file: 'intranet/rent-support-review.html', system: 'intranet', title: 'Rent support review procedure', body });
}

const camel = (s) => s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (x, ch) => ch.toUpperCase());

function messagesJson(c, others = []) {
  const doc = {
    clientId: c.clientId, name: fullName(c.person), dateOfBirth: c.person.dob,
    messages: c.messages.map((m) => ({
      number: m.n, id: m.id, received: `${m.received}:00Z`, type: m.type, channel: m.channel, subject: m.subject, status: m.status, body: m.body,
      ...(m.form ? { form: { name: m.form.name, answers: Object.fromEntries(m.form.answers.map(([k, v]) => [camel(k), v])) } } : {}),
    })),
    referrals: others.filter((r) => r.referral).map((r) => ({
      id: r.id, received: `${r.received}:00Z`, referredBy: r.referral.org, reason: r.referral.reason, urgency: r.referral.urgency,
      referralStatus: r.referral.status, respondBy: r.referral.respondBy, referrer: { ...r.referral.contact },
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Every generated file: { 'cm/queue.html': text, … }, paths relative to demo/. */
export function buildFiles(cases = buildData(), referrals = buildReferrals(cases)) {
  const files = {};
  const othersOf = new Map(cases.map((c) => [c.clientId, []]));
  for (const r of [...referrals].sort((a, b) => b.received.localeCompare(a.received))) othersOf.get(r.clientId).push(r);
  const pages = Math.ceil(cases.length / PAGE_SIZE);
  for (let n = 1; n <= pages; n++) files[n === 1 ? 'cm/queue.html' : `cm/queue-${n}.html`] = queuePage(cases, n, pages);
  files['cm/index.html'] = cmHomePage(cases);
  files['intranet/index.html'] = intranetHome();
  files['intranet/rent-support-review.html'] = intranetReview(cases);
  const listPages = pagesOf(cases);
  for (let n = 1; n <= listPages; n++) {
    files[`biv/${pageName('index')(n)}`] = bivListPage(cases, n);
    files[`harbour/${pageName('index')(n)}`] = harbourListPage(cases, n);
    files[`messages/${pageName('clients')(n)}`] = clientListPage(cases, n, (c) => c.messages.length + othersOf.get(c.clientId).length);
  }
  const inbox = inboxRows(cases, referrals);
  for (let n = 1; n <= pagesOf(inbox); n++) files[`messages/${pageName('index')(n)}`] = inboxPage(inbox, n);
  for (const c of cases) {
    files[`cm/case-${c.no}.html`] = casePage(c);
    files[`cm/notes-${c.no}.html`] = notesPage(c);
    files[`biv/income-${c.clientId}.html`] = incomePage(c);
    files[`harbour/tenancy-${c.tenancy.ref}.html`] = tenancyPage(c);
    files[`messages/client/${c.clientId}.html`] = clientMessagesPage(c, othersOf.get(c.clientId));
    for (const m of c.messages) files[`messages/message/${c.clientId}-${m.n}.html`] = messagePage(c, m);
    files[`messages/api/${c.clientId}.json`] = messagesJson(c, othersOf.get(c.clientId));
  }
  for (const r of referrals) files[`messages/message/${r.id}.html`] = orgMessagePage(r);
  return files;
}

export const digest = (files) => createHash('sha256').update(Object.keys(files).sort().map((k) => `${k}\n${files[k]}`).join('\0')).digest('hex');

/** Write the pages into dir (demo/ by default), replacing the generator's folders. */
export async function writeSystems(dir = demoRoot, files = buildFiles()) {
  for (const d of SYSTEM_DIRS) await fs.rm(path.join(dir, d), { recursive: true, force: true });
  const made = new Set();
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    const parent = path.dirname(full);
    if (!made.has(parent)) { await fs.mkdir(parent, { recursive: true }); made.add(parent); }
    await fs.writeFile(full, text);
  }
  return Object.keys(files).length;
}

/** Are the generator's folders under dir exactly these files? */
export async function upToDate(dir = demoRoot, files = buildFiles()) {
  const want = Object.keys(files).sort();
  const have = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r); else have.push(r);
    }
  };
  for (const d of SYSTEM_DIRS) await walk(d);
  have.sort();
  if (want.join('\n') !== have.join('\n')) return false;
  for (const k of want) if ((await fs.readFile(path.join(dir, k), 'utf8')) !== files[k]) return false;
  return true;
}

/** Write the pages unless they're already current: what `pnpm demo` and the site build call. */
export async function ensureSystems(dir = demoRoot) {
  const files = buildFiles();
  if (await upToDate(dir, files)) return { written: 0, total: Object.keys(files).length };
  return { written: await writeSystems(dir, files), total: Object.keys(files).length };
}

/** Problems with the data: anything that could look real. Empty when every value is from the fictional ranges. */
export function fictionProblems(cases = buildData(), files = buildFiles(cases)) {
  const out = [];
  const text = Object.values(files).join('\n');
  for (const m of text.matchAll(/\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g)) if (!m[0].startsWith('QQ')) out.push(`NI number ${m[0]} doesn’t start QQ`);
  for (const m of text.matchAll(/\b0\d{3,4} ?\d{6}\b/g)) if (!/^07700 ?900\d{3}$/.test(m[0])) out.push(`phone ${m[0]} isn’t in 07700 900xxx`);
  for (const m of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) if (!['example.org', 'example.com'].includes(m[1])) out.push(`email at ${m[1]}`);
  for (const m of text.matchAll(/\b([A-Z]{1,2})\d[A-Z\d]? \d[A-Z]{2}\b/g)) if (m[1] !== 'NS') out.push(`postcode ${m[0]} isn’t in the NS area`);
  if (/<script(?![^>]*src="(?:\.\.\/)+assets\/casework\.js")/i.test(text)) out.push('a page has a script other than assets/casework.js');
  if (/https?:\/\//.test(Object.entries(files).filter(([k]) => k.endsWith('.html')).map(([, v]) => v).join(''))) out.push('a page links to another site');
  const ninos = cases.map((c) => c.person.nino);
  if (new Set(ninos).size !== ninos.length) out.push('two people share an NI number');
  return [...new Set(out)];
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const files = buildFiles();
  if (process.argv.includes('--check')) {
    const problems = [];
    if (digest(buildFiles(buildData())) !== digest(files)) problems.push('two builds from the same seed differ');
    problems.push(...fictionProblems(buildData(), files));
    const onDisk = await fs.stat(path.join(demoRoot, 'cm')).then(() => true, () => false);
    if (onDisk && !(await upToDate(demoRoot, files))) problems.push('the pages in demo/ are out of date: run node tools/build-demo-systems.mjs');
    if (problems.length) { process.stderr.write(`${problems.join('\n')}\n`); process.exitCode = 1; }
    else process.stdout.write(`Demo systems: ${Object.keys(files).length} files, deterministic (${digest(files).slice(0, 12)}), fictional${onDisk ? ', current on disk' : ''}\n`);
  } else {
    const n = await writeSystems(demoRoot, files);
    if (!process.argv.includes('--quiet')) process.stdout.write(`Wrote ${n} files for the demo systems into demo/ (${SYSTEM_DIRS.join('/, ')}/)\n`);
  }
}
