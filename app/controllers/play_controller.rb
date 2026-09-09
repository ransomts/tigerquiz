# The player side: the join page and the two lookups it makes before subscribing.
class PlayController < ApplicationController
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
