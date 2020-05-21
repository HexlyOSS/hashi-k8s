
const core = require('@actions/core');
const { parseTemplate } = require('./action');

(async () => {
  try {
    await core.group('Parse template', parseTemplate);
  } catch (error) {
    core.setFailed(error.message);
  }
})()
