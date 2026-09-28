#!/bin/sh
. "$(dirname "$0")/common.sh"
compose config --quiet
compose build api
compose build web
compose run --rm --no-deps web -t
