import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import { registerBusiness } from './business.js';
import { registerFiles } from './files.js';
import { publicTenant, requestContext, requestOrigin } from './tenancy.js';
import { registerPosAuth } from './pos-auth.js';
import { registerHandoffPublic } from './session-handoff.js';

export function buildApp({ database = null, logger = false, auth = null, authOptions = null, uploadDir = null } = {}) {
  const app = Fastify({
    logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: false,
    bodyLimit: 2 * 1024 * 1024, requestTimeout: 10000, connectionTimeout: 10000,
    keepAliveTimeout: 5000, return503OnClosing: true
  });
  let closing = false;
  app.decorateRequest('tenant', null);
  app.addHook('onClose', async () => { await database?.close(); });
  app.addHook('preClose', async () => { closing = true; });
  app.setErrorHandler((error, _request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : ['23505','23503','23514'].includes(error.code) ? 409 : 500;
    reply.code(status).send({ error: status === 500 ? 'internal_error' : error.code?.startsWith('FST_') ? (status === 413 ? 'payload_too_large' : 'invalid_request') : error.statusCode ? error.message : 'record_conflict' });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options','nosniff');
    if (!authOptions || req.url.startsWith('/api/health/')) return;
    req.tenant=await requestContext(database,req,authOptions);
    if(authOptions.enforceTenantHosts&&!req.tenant)return reply.code(404).send({error:'not_found'});
    if(req.tenant?.redirect_to&&!['GET','HEAD','OPTIONS'].includes(req.method))return reply.code(409).send({error:'canonical_host_required',redirectTo:`${authOptions.protocol}//${req.tenant.redirect_to}`});
    const origin=authOptions.enforceTenantHosts?requestOrigin(req,authOptions):authOptions.origin;
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')) return reply.code(403).send({error:'origin_required'});
  });
  if (auth) {
    app.register(rateLimit, {max:300,timeWindow:60000});
    app.get('/api/tenant-context',async(req,reply)=>{
      if(!req.tenant)return reply.code(404).send({error:'not_found'});
      return publicTenant(req.tenant);
    });
    registerPosAuth(app,{db:database,authOptions});
    registerHandoffPublic(app,{db:database,authOptions});
    const allowed = new Set(['/api/auth/sign-in/email','/api/auth/sign-out','/api/auth/get-session','/api/auth/change-password']);
    app.route({method:['GET','POST'],url:'/api/auth/*',bodyLimit:16384,config:{rateLimit:{max:60,timeWindow:60000}},async handler(req,reply){
      const path=req.url.split('?')[0];
      if(!allowed.has(path))return reply.code(404).send({error:'not_found'});
      const headers=fromNodeHeaders(req.headers);
      for(const key of ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip'])headers.delete(key);
      const origin=authOptions.enforceTenantHosts?requestOrigin(req,authOptions):authOptions.origin;
      const response=await auth.handler(new Request(new URL(req.url,origin),{method:req.method,headers,...(req.body?{body:JSON.stringify(req.body)}:{})}));
      reply.code(response.status);
      response.headers.forEach((value,key)=>{if(key!=='set-cookie')reply.header(key,value);});
      const cookies=response.headers.getSetCookie();if(cookies.length)reply.header('set-cookie',cookies);
      if(response.status>=400)return reply.send({error:'authentication_failed'});
      return reply.send(response.body?await response.text():null);
    }});
    registerBusiness(app,{database,auth,authOptions});
    if(uploadDir)app.register(async scoped=>registerFiles(scoped,{database,uploadDir}));
  }
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (closing) return reply.code(503).send({ status: 'unavailable', reason: 'shutting_down' });
    if (!database) return reply.code(503).send({ status: 'unavailable', reason: 'configuration_unavailable' });
    try {
      if (await database.ready()) return { status: 'ready' };
    } catch { /* Do not serialize driver errors, connection details or credentials. */ }
    return reply.code(503).send({ status: 'unavailable', reason: 'database_unavailable' });
  });
  return app;
}
