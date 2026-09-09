# The player side: the join page and the two lookups it makes before subscribing.
class PlayController < ApplicationController
  # PINs are six digits and these two endpoints are open by design, so without a
  # limit the whole PIN space is walkable: the payoff is joining, or merely
  # detecting, somebody else's live game. A class of thirty arriving at once is
  # thirty requests from thirty phones, so the ceiling is per address and set
  # well above what one real student does.
  rate_limit to: 30, within: 1.minute, only: %i[join lobby],
             with: -> { render json: { ok: false, error: "Too many tries. Wait a moment and try again." }, status: :too_many_requests }

  def index; end

  # What the join screen must ask for before a player can enter.
  def lobby
    Games::Registry.with_room(json_body["pin"]) do |room|
      return render json: { ok: false, error: "Game not found" } unless room

      render json: room.lobby_info.merge("ok" => true)
    end
  end

  def join
    body = json_body
    Games::Registry.with_room(body["pin"]) do |room|
      return render json: { ok: false, error: "Game not found" } unless room

      render json: room.join(body["name"], body["identifier"])
    end
  end
end
