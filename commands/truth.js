const { auditTruth, formatTruth } = require('../lib/truth');

async function main() {
  const report = await auditTruth();
  console.log(`\n${formatTruth(report)}\n`);
}

module.exports = { main };

main().catch(err => {
  console.error(`\nTruth audit unavailable: ${err.message}\n`);
  process.exitCode = 1;
});
