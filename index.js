import { group, setFailed } from '@actions/core';
import { parseTemplate } from './action';

(async () => {
  try {
    await group('Parse template', parseTemplate);
  } catch (error) {
    setFailed(error.message);
  }
})()
