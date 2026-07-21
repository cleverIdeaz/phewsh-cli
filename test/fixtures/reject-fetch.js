'use strict';

global.fetch = () => {
  throw new Error('Unexpected network access in local-only CLI path.');
};
