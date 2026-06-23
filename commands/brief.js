const { generateBrief } = require('../lib/brief');

async function main() {
  const { content } = await generateBrief();
  console.log(`\n${content}\n`);
}

module.exports = { main };

main().catch(err => {
  console.error(`\nBrief unavailable: ${err.message}\n`);
  process.exitCode = 1;
});
