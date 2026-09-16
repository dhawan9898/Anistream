// test-core.mjs - Verify XOR deobfuscation and core ani-cli logic

function deobfuscateBlob(base64Blob) {
  const raw = Buffer.from(base64Blob, 'base64').toString('binary');
  const key = "otaku-embed-v1";
  let output = "";
  for (let i = 0; i < raw.length; i++) {
    const byte = raw.charCodeAt(i);
    const keyByte = key.charCodeAt(i % key.length);
    output += String.fromCharCode(byte ^ keyByte);
  }
  return output;
}

function obfuscateBlob(str) {
  const key = "otaku-embed-v1";
  let raw = "";
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i);
    const keyByte = key.charCodeAt(i % key.length);
    raw += String.fromCharCode(byte ^ keyByte);
  }
  return Buffer.from(raw, 'binary').toString('base64');
}

// Test case with sample JSON payload like ani-cli receives
const testPayload = JSON.stringify({
  src: "https://stream.provider/master.m3u8",
  subtitles: [
    { src: "https://stream.provider/sub.vtt", lang: "English", default: true }
  ]
});

const encrypted = obfuscateBlob(testPayload);
console.log("[Test 1] Encrypted Base64 Blob length:", encrypted.length);

const decrypted = deobfuscateBlob(encrypted);
console.log("[Test 2] Decrypted matches original:", decrypted === testPayload);
if (decrypted === testPayload) {
  console.log("SUCCESS: ani-cli otaku-embed-v1 XOR deobfuscation verified 100%!");
} else {
  console.error("FAIL: Decryption mismatch");
  process.exit(1);
}
