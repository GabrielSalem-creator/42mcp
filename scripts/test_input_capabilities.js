const boxdClient = require('../src/boxdClient');

async function testClear() {
  await boxdClient.exec('DISPLAY=:100 agent-browser press Control+a && agent-browser press Backspace');
  const val = await boxdClient.exec("DISPLAY=:100 agent-browser eval 'document.querySelector(\"input[name=\\\"email\\\"], input[name=\\\"username\\\"]\").value'");
  console.log('Value after clear:', val.stdout.trim());
}

testClear().catch(console.error);
