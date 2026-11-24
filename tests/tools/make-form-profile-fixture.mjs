// Create a candidate for fixtures/form-profile.json. Never overwrite the frozen reference.
import fs from 'node:fs';
import { formProfileParts } from '../../extension/lib/casetype.js';
const read = (name) => JSON.parse(fs.readFileSync(new URL(`../../extension/templates/${name}.json`, import.meta.url), 'utf8'));
const ct = read('casetype-housing-referral'), fill = read('fill-casetype-housing-referral');
const target = Object.fromEntries(Object.entries(fill.fields).map(([k, v]) => [v.split('.').slice(1).join('.'), k]));
const examples = { title: 'Mr', firstName: 'Sam', lastName: 'Example', dob: '1990-02-03', nino: 'QQ123456C', phone: '07700 900000', email: 'sam@example.org', contactPref: 'Email', consent: true, opened: '2026-01-05', risk: 'Medium', postcode: 'ZZ1 1ZZ' };
const schema = { firstName: 'Person.givenName', lastName: 'Person.familyName', dob: 'Person.birthDate', phone: 'Person.telephone', email: 'Person.email', postcode: 'Person.address.postalCode', orgName: 'Organization.legalName' };
const fields = ct.fields.map((f) => {
  if (f.type === 'list') {
    const list = fill.lists[0];
    const targets = Object.fromEntries(Object.entries(list.fields).map(([k, v]) => [v.slice(1), k.replace(/\[name=([^\]]+)\]/g, '[name="$1"]')]));
    return { ...f, rows: '#household > tr', add: list.add, fields: f.fields.map((sub) => ({ ...sub, target: targets[sub.key] })), example: [{ name: 'Alex Example', relationship: 'Son', dob: '2015-06-01' }] };
  }
  return { ...f, target: target[f.key], ...(f.key in examples ? { example: examples[f.key] } : {}), ...(f.key in schema ? { schema: schema[f.key] } : {}) };
});
const draft = { name: ct.name, description: ct.description, url: ct.form.url, match: [ct.form.url], fields };
process.stdout.write(JSON.stringify({ draft, expected: formProfileParts(draft) }, null, 1) + '\n');
