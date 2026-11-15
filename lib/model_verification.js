'use strict';

// Web mode selectors (Auto/Pro/Fast/Thinking) do not identify a model version.
// There is currently no validated Google response field available to this adapter
// that attests to the model used for an individual generation.
function modelVerificationError(model) {
  return {
    error: {
      message: 'Gemini 4 не подтверждена: веб-режим не подтверждает фактическую модель ответа. Генерация заблокирована.',
      type: 'model_verification_error',
      code: 'model_identity_unverified',
      requested_model: model,
    },
  };
}

module.exports = { modelVerificationError };
