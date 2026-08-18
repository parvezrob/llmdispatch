#!/bin/sh
# Two questions, two answers.
#
# What an adopter installs must be permissive, because it ends up inside their product.
# What builds this package never ships, so a few licences that would be wrong to
# redistribute are fine to compile with. Both lists are closed: a licence that is not
# named below fails the check and has to be looked at, which is the point.
set -eu

SHIPPED="MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;0BSD;BlueOak-1.0.0"
BUILD_ONLY="MPL-2.0;CC0-1.0;CC-BY-3.0;(MIT AND CC-BY-3.0)"

echo "what an adopter would install:"
npx --no-install license-checker-rseidelsohn --production --onlyAllow "$SHIPPED"

echo "what builds this package:"
npx --no-install license-checker-rseidelsohn --onlyAllow "$SHIPPED;$BUILD_ONLY"
