module ApplicationCable
  # Players are anonymous and hosts prove themselves per game with a token, so
  # the connection itself carries no identity.
  class Connection < ActionCable::Connection::Base
  end
end
