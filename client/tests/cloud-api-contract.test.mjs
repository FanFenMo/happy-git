import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const { startDatabaseWorker,callDatabase,closeDatabaseWorker }=require('../electron/database.cjs')
const { CloudService }=require('../electron/cloud-service.cjs')

test('cloud API preserves UUID streams, event scope, global revisions and consent boundaries',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'happygit-cloud-api-'))
 await startDatabaseWorker(path.join(directory,'test.db'))
 try {
  const accountId='1001', context={accountId}
  await callDatabase('saveProfile',{accountId,profile:{accountId,login:'fixture',fetchedAt:Date.now()}})
  const repo={repoId:'23418517',fullName:'apache/hadoop',canonicalKey:'apache/hadoop',visibility:'public'}
  await callDatabase('recordBrowse',{accountId,repository:repo,source:'feed',viewedAt:Date.now()-120000})
  let epoch=1,revision=0,enabled=true,accepted=0,failPreferences=false
  const stream=()=>`11111111-2222-4333-8444-${String(epoch).padStart(12,'0')}`
  const preferences=()=>({revision,analysisEpoch:epoch,analysisEnabled:enabled,manualTags:[],hiddenRepoIds:[]})
  const uploaded=[]
  const service=new CloudService({database:{callDatabase},fetchImpl:async(url,options)=>{
   const body=options.body?JSON.parse(options.body):null
   const route=new URL(url).pathname
   let response
   if(route==='/api/v2/devices/register') response={deviceId:'fixture-device',streamEpoch:stream(),analysisEpoch:epoch,acceptedThrough:accepted,exportedThrough:0,processedThrough:0,preferences:preferences()}
   else if(route==='/api/v2/me/preferences'&&options.method==='GET') response=preferences()
   else if(route==='/api/v2/me/preferences') {
    if(failPreferences) return {ok:false,status:503,text:async()=>JSON.stringify({code:'PERSISTENCE_UNAVAILABLE',message:'fixture failure'})}
    assert.equal(body.expectedRevision,revision)
    assert.ok(Array.isArray(body.manualTags)&&Array.isArray(body.hiddenRepoIds))
    if(body.analysisEnabled!==enabled){epoch++;accepted=0}
    enabled=body.analysisEnabled;revision++;response=preferences()
   } else if(route==='/api/v2/me/collections'){
    assert.equal(body.expectedRevision,revision)
    assert.equal(body.analysisEpoch,epoch)
    revision++;response={revision,analysisEpoch:epoch,complete:true}
   } else if(route==='/api/v2/me/analysis/reset'){
    assert.equal(body.expectedRevision,revision)
    epoch++;revision++;accepted=0;response=preferences()
   } else if(route==='/api/v2/events/batches'){
    assert.equal(body.streamEpoch,stream())
    assert.equal(body.analysisEpoch,epoch)
    assert.equal(body.firstSeq,accepted+1)
    for(const event of body.events){
     if(event.recordKind==='open'){
      assert.equal(event.schemaVersion,'1.0.0')
      assert.equal(event.streamEpoch,body.streamEpoch)
      assert.equal(event.analysisEpoch,body.analysisEpoch)
      const tuple=['1.0.0',event.eventId,stream(),event.deviceSeq,epoch,event.repoId,event.occurredAt,event.source]
      assert.equal(event.payloadHash,crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex'))
     }
    }
    uploaded.push(body);accepted=body.events.at(-1).deviceSeq
    response={streamEpoch:stream(),analysisEpoch:epoch,acceptedThrough:accepted,exportedThrough:0,processedThrough:0}
   } else throw new Error(`Unexpected ${options.method} ${route}`)
   return {ok:true,status:200,text:async()=>JSON.stringify(response)}
  }})
  await service.saveTokens(accountId,{accessToken:'a'.repeat(43),refreshToken:'r'.repeat(43),expiresAt:Date.now()+3600000,cloudAccountId:accountId})
  await callDatabase('saveCloudAccountState',{accountId,patch:{cloudBound:true,cloudAccountId:accountId}})
  let state=await service.registerDeviceAndSyncStream(accountId)
  assert.equal(state.streamEpoch,stream())
  assert.equal(state.pendingCount,1)
  const firstFlush=await service.flushOutbox(context)
  assert.equal(firstFlush.flushed,true,JSON.stringify(firstFlush))
  assert.equal(uploaded.length,1)
  assert.equal((await callDatabase('readCloudSyncState',{accountId})).processedThrough,0)
  await callDatabase('recordBrowse',{accountId,repository:{...repo,repoId:'2',canonicalKey:'fixture/two'},source:'feed'})
  assert.equal((await callDatabase('readCloudSyncState',{accountId})).pendingCount,1)
  await service.savePreferences(context,{analysisEnabled:false})
  state=await callDatabase('readCloudSyncState',{accountId})
  assert.equal(state.pendingCount,0)
  assert.equal(state.analysisEnabled,false)
  await service.savePreferences(context,{analysisEnabled:true})
  for(const kind of ['stars','repos']){
   const {generationId}=await callDatabase('beginSync',{accountId,kind})
   await callDatabase('writeSyncPage',{accountId,kind,generationId,pageSeq:1,items:[repo],nextUrl:null})
   await callDatabase('finishSync',{accountId,kind,generationId})
  }
  const collections=await service.syncCollections(context,['stars','owned'])
  assert.equal(collections.results.stars.uploaded,true,JSON.stringify(collections))
  assert.equal(collections.results.owned.uploaded,true,JSON.stringify(collections))
  assert.equal(revision,4)
  await callDatabase('recordBrowse',{accountId,repository:{...repo,repoId:'3',canonicalKey:'fixture/three'},source:'feed'})
  const nextFlush=await service.flushOutbox(context)
  assert.equal(nextFlush.flushed,true,JSON.stringify(nextFlush))
  assert.equal(uploaded.at(-1).firstSeq,1)
  const previousStream=stream(), previousEpoch=epoch
  const reset=await service.resetAnalysis(context)
  assert.equal(reset.cloudSync.streamEpoch,stream())
  assert.equal(reset.cloudSync.acceptedThrough,0)
  const staleAck=await callDatabase('applyOutboxAck',{accountId,ackPayload:{streamEpoch:previousStream,analysisEpoch:previousEpoch,acceptedThrough:99}})
  assert.equal(staleAck.streamEpoch,stream())
  assert.equal(staleAck.acceptedThrough,0)
  assert.equal((await callDatabase('listHistory',{accountId})).total,3)
  failPreferences=true
  await assert.rejects(service.savePreferences(context,{analysisEnabled:false}),error=>error.code==='PERSISTENCE_UNAVAILABLE')
 } finally {
  await closeDatabaseWorker()
  fs.rmSync(directory,{recursive:true,force:true})
 }
})