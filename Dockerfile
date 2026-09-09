# tigerquiz — self-hosted live quiz server, Rails version.
#
# Games live in the process's memory, so this image runs exactly one Puma
# process with no workers. Never scale it to more than one container either:
# two containers would each hold their own games and a PIN would find the
# wrong one. See PORT.md.
#
# quizzes/ and storage/ are bind-mounted in compose; the image ships the demo
# quizzes so it also runs standalone.

ARG RUBY_VERSION=3.2.3
FROM ruby:${RUBY_VERSION}-slim AS build

# Build-only: native extensions for sqlite3 and bootsnap.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential git pkg-config libyaml-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /rails
ENV RAILS_ENV=production BUNDLE_DEPLOYMENT=1 BUNDLE_PATH=/usr/local/bundle BUNDLE_WITHOUT=development:test

# Gems first, so editing the app does not reinstall them.
COPY Gemfile Gemfile.lock ./
RUN bundle install && \
    rm -rf ~/.bundle "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git

COPY . .

RUN bundle exec bootsnap precompile app/ lib/

# Assets are digested at build time; SECRET_KEY_BASE_DUMMY lets that happen
# without the real secret, which only the running container needs.
RUN SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile

# ---------- the image that actually runs ----------
FROM ruby:${RUBY_VERSION}-slim

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y curl libsqlite3-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /rails
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY --from=build /rails /rails

ENV RAILS_ENV=production \
    BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_WITHOUT=development:test \
    RAILS_LOG_TO_STDOUT=1

# Never as root. The uid is overridden in compose to match the host owner of
# the mounted quizzes/ and storage/ directories.
RUN groupadd --system --gid 1000 rails && \
    useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash && \
    mkdir -p db log storage tmp && \
    chown -R rails:rails db log storage tmp
USER 1000:1000

EXPOSE 3000

# Create or migrate the database, then serve. Both are safe to repeat.
ENTRYPOINT ["/rails/bin/docker-entrypoint"]
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]
