import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'stream_cache/**/*', 'temp_uploads/**/*', 'local_object_store/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
