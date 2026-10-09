const boxdClient = require('./src/boxdClient');

async function testBody() {
  const urlRes = await boxdClient.exec('DISPLAY=:100 agent-browser get url');
  const titleRes = await boxdClient.exec('DISPLAY=:100 agent-browser get title');
  const snapRes = await boxdClient.exec('DISPLAY=:100 agent-browser snapshot');
  console.log('URL:  ', urlRes.stdout.trim());
  console.log('Title:', titleRes.stdout.trim());
  console.log('Snapshot:\n', snapRes.stdout.slice(0, 400));
}

testBody();
