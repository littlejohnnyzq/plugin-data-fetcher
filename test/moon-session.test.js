const {test}=require('node:test');const assert=require('node:assert/strict');
const {createMoonSession}=require('../moon-session');
test('website mode only accepts a verified Moon8s cookie, never legacy or header claims',async()=>{
 const token='x'.repeat(43);let calls=0;
 const lookup=createMoonSession({fetcher:async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:1089/api/site/session');assert.equal(options.headers.Cookie,'__Host-moon_session='+token);return {ok:true,json:async()=>({user:{id:'real-user',name:'Real'}})};}});
 assert.equal(await lookup({headers:{cookie:'plugin_data_session=old','x-user-id':'fake'}}),null);assert.equal(calls,0);
 assert.equal((await lookup({headers:{cookie:'__Host-moon_session='+token}})).userId,'real-user');
 const expired=createMoonSession({fetcher:async()=>({ok:true,json:async()=>({user:null})})});assert.equal(await expired({headers:{cookie:'__Host-moon_session='+token}}),null);
 const failed=createMoonSession({fetcher:async()=>{throw Error('offline')}});await assert.rejects(failed({headers:{cookie:'__Host-moon_session='+token}}),{status:503});
});

test('admin role comes only from the validated website session',async()=>{
 for(const [role,expected] of [[true,true],[false,false],[undefined,false],['true',false]]){
  const lookup=createMoonSession({fetcher:async()=>({ok:true,json:async()=>({user:{id:'user',isAdmin:role}})})});
  const user=await lookup({headers:{cookie:'__Host-moon_session='+'x'.repeat(43),'x-admin':'true'}});
  assert.equal(user.isAdmin,expected);
 }
});
