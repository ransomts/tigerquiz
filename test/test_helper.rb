ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module ActiveSupport
  class TestCase
    # Run tests in parallel with specified workers
    parallelize(workers: :number_of_processors)

    # Setup all fixtures in test/fixtures/*.yml for all tests in alphabetical order.
    fixtures :all

    # Rate-limit counters live in the cache, so one test's requests would
    # otherwise still be counted against the next one's.
    setup { ActionController::Base.cache_store.clear }

    # Requests made as a signed-in instructor carry the header Apache would set.
    def as(eppn)
      { "X-Remote-User" => eppn }
    end
  end
end
