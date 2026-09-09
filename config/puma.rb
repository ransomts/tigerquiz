# This configuration file will be evaluated by Puma. The top-level methods that
# are invoked here are part of Puma's configuration DSL. For more information
# about methods provided by the DSL, see https://puma.io/puma/Puma/DSL.html.
#
# Puma starts a configurable number of processes (workers) and each process
# serves each request in a thread from an internal thread pool.
#
# You can control the number of workers using ENV["WEB_CONCURRENCY"]. You
# should only set this value when you want to run 2 or more workers. The
# default is already 1. You can set it to `auto` to automatically start a worker
# for each available processor.
#
# The ideal number of threads per worker depends both on how much time the
# application spends waiting for IO operations and on how much you wish to
# prioritize throughput over latency.
#
# As a rule of thumb, increasing the number of threads will increase how much
# traffic a given process can handle (throughput), but due to CRuby's
# Global VM Lock (GVL) it has diminishing returns and will degrade the
# response time (latency) of the application.
#
# The default is set to 3 threads as it's deemed a decent compromise between
# throughput and latency for the average Rails application.
#
# Any libraries that use a connection pool or another resource pool should
# be configured to provide at least as many connections as the number of
# threads. This includes Active Record's `pool` parameter in `database.yml`.
threads_count = ENV.fetch("RAILS_MAX_THREADS", 8)
threads threads_count, threads_count

# tigerquiz keeps every running game in memory, so it must run as exactly one
# process. Never set WEB_CONCURRENCY above 1 (see PORT.md).
workers 0

# Behind Apache, listen on a Unix socket that only Apache can reach (see
# config/deploy/apache.conf.example). Otherwise, a TCP port for development.
if ENV["PUMA_SOCKET"]
  bind "unix://#{ENV["PUMA_SOCKET"]}"
else
  port ENV.fetch("PORT", 3000)
end

# Games live in this process's memory, so a restart has already destroyed every
# room that was open, and the rows they left behind can never finish or be
# resumed. Sweep them as the server comes up. This belongs to booting the game
# server and nothing else: a rake task or a console must not delete a game that
# a running server is still playing.
# Puma 8 renamed this hook and the Gemfile still allows older versions.
send(respond_to?(:after_booted) ? :after_booted : :on_booted) do
  swept = Game.sweep_unfinished!
  Rails.logger.info("Swept #{swept} unfinished #{"game".pluralize(swept)} left by an earlier run") if swept > 0
rescue StandardError => e
  # a database that is not there yet must not stop the server booting
  Rails.logger.warn("Could not sweep unfinished games: #{e.class}: #{e.message}")
end

# Allow puma to be restarted by `bin/rails restart` command.
plugin :tmp_restart

# Specify the PID file. Defaults to tmp/pids/server.pid in development.
# In other environments, only set the PID file if requested.
pidfile ENV["PIDFILE"] if ENV["PIDFILE"]
