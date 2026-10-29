'use strict';
const {createHash}=require('node:crypto');
// Validate the actual HttpOnly website cookie with the loopback website service.
// Never trust a client-supplied X-User header or a legacy product password cookie.
function createMoonSession({endpoint='http://127.0.0.1:1089/api/site/session',fetcher=fetch}={}){
  return async function moonSession(req){
    const token=/(?:^|;\s*)__Host-moon_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
    if(!token)return null;
    let response;
    try{response=await fetcher(endpoint,{headers:{Cookie:'__Host-moon_session='+token},signal:AbortSignal.timeout(5000)});}
    catch{throw Object.assign(new Error('登录服务暂不可用，请稍后重试。'),{status:503});}
    if(!response.ok)throw Object.assign(new Error('登录服务暂不可用，请稍后重试。'),{status:503});
    const {user}=await response.json();
    if(!user || typeof user.id!=='string')return null;
    return {userId:user.id,name:user.name,isAdmin:user.isAdmin===true,csrf:createHash('sha256').update('moon8s-tool-csrf:'+token).digest('hex')};
  };
}
module.exports={createMoonSession};
