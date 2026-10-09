const boxdClient = require('./src/boxdClient');

async function testCurlNatgeo() {
  const r = await boxdClient.exec('curl -s -I -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" https://www.instagram.com/natgeo/');
  console.log(r.stdout);
}

testCurlNatgeo();
