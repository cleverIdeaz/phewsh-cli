const fs = require('fs');
const path = require('path');

const args = process.argv.slice(3);

console.log(`
  🌿 Sustainable AI Protocol (SAP)

  Track AI usage and environmental impact across your tools.

  Status: SDK available, dashboard coming soon.

  Quick links:
    Web:  https://phewsh.com/sap
    Docs: https://sustainableaiprotocol.com

  To embed SAP tracking in your project:
    const SAP = require('sustainable-ai-protocol');
    const passport = await SAP.createPassport({ model: 'claude-opus', tokens: 1500 });
`);
