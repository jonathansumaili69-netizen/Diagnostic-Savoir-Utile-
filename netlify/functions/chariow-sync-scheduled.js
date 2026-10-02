'use strict';
const{schedule}=require('@netlify/functions');const chariow=require('../../src/core/chariow');const{logger}=require('../../src/core/logger');
const job=async()=>{try{const r=await chariow.syncSales();logger.info('chariow-sync: termine',r)}catch(err){logger.error('chariow-sync: echec',{error:err.message})}return{statusCode:200,body:'ok'}};
exports.handler=schedule('17 */3 * * *',job);
