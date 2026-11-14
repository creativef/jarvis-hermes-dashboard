// Runs the shipped spoken-approval rule from ui/app.js: only an answer that IS a yes approves.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const code = src.slice(src.indexOf('// ── spoken approval answers ──'), src.indexOf('// ══════════ approvals:'));
const parse = new Function(code + '; return parseApproval;')();
let ok = true;
const check = (heard, want) => {
  const got = parse(heard), pass = got === want;
  console.log((pass ? 'PASS ' : 'FAIL ') + JSON.stringify(heard) + ' -> ' + got + (pass ? '' : ' (wanted ' + want + ')'));
  ok = ok && pass;
};
for (const t of ['yes', 'Yes.', 'yeah', 'okay', 'Ok!', 'sure, go ahead', 'yes please', 'okay, do it', 'well, yes', 'approve', 'Yes, go ahead. Thanks.'])
  check(t, 'once');
for (const t of ['no', 'No, stop.', "don't", 'yes... no, cancel', 'okay no', 'never'])
  check(t, 'deny');
for (const t of ["I am not sure, hold on", 'okay what does that command do', 'are you sure about that', 'ok google',
                 'is that okay with everyone', 'yes or maybe later', '', 'hmm'])
  check(t, null);
process.exit(ok ? 0 : 1);
