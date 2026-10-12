async function testAuth() {
  console.log("Sending OTP to Customer...");
  let sendRes = await fetch('http://localhost:3001/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9876543210' }) });
  console.log("Send OTP status:", sendRes.status, await sendRes.text());
  
  console.log("Verifying OTP for Customer...");
  let verifyRes = await fetch('http://localhost:3001/api/auth/verify-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9876543210', otp: '123456', expected_role: 'CUSTOMER' })
  });
  console.log("Verify OTP status:", verifyRes.status, await verifyRes.text());
}
testAuth();
