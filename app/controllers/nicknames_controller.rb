# The join screen offers players a name rather than letting them invent one.
class NicknamesController < ApplicationController
  # The dice button is one click, and a player presses it a handful of times at
  # most. Anything faster is a script.
  rate_limit to: 60, within: 1.minute,
             with: -> { render json: { error: "Too many tries. Wait a moment and try again." }, status: :too_many_requests }

  def show
    render json: { name: Tigerquiz::Nicknames.suggest }
  end
end
