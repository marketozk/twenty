import base from '/source/packages/twenty-server/jest-fork-migration.config.mjs';
export default {...base,rootDir:'/source/packages/twenty-server',clearMocks:true,fakeTimers:{enableGlobally:true}};
