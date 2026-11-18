'use strict';

const CYBERCAB_X_CHECK_UNAVAILABLE = 'CYBERCAB-X-CHECK-UNAVAILABLE';

function cyberCabXCheckUnavailable(values) {
  const list = Array.isArray(values) ? values : [values];
  return list.some((value) =>
    String(value || '')
      .toUpperCase()
      .includes(CYBERCAB_X_CHECK_UNAVAILABLE),
  );
}

module.exports = {
  CYBERCAB_X_CHECK_UNAVAILABLE,
  cyberCabXCheckUnavailable,
};
